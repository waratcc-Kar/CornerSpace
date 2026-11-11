/* Corner Space — Cloudflare Worker
   - เสิร์ฟหน้าเว็บ (public/) และ API ข้อมูล (/api/*) เก็บใน D1
   - ล็อกอินพนักงาน: Cloudflare Access (Worker ตรวจ JWT ซ้ำอีกชั้น)
   - /api/photo  : อ่านรูปรถ/ป้ายประกันด้วย Claude (คีย์เก็บเป็น secret)
   - /api/line/push, /line-webhook : ส่ง/รับข้อความ LINE OA
   - scheduled   : ทุกวัน 09:00 เวลาไทย เตือนลูกค้าที่นัดบริการพรุ่งนี้ */

import { KB } from "./knowledge.js";

const COLLS = new Set(["jobs", "customers", "bookings", "settings"]);
const LIMITS = { jobs: 500, customers: 2000, bookings: 1000, settings: 20 };
const MAX_DOC = 1_800_000;             /* D1: 1 แถวไม่เกิน ~2MB */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MODEL = "claude-sonnet-5-5";   /* ถ้าอ่านลายมือไม่แม่น ตั้งตัวแปร MODEL เป็น claude-sonnet-5-5 */

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, error, message) => json({ error, message }, status);
const normPhone = (p) => String(p || "").replace(/\D/g, "").replace(/^66/, "0");
const list = (s) => String(s || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const rand = (n = 8) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (b) => (b % 36).toString(36)).join(""); };

/* ---------------- ฐานข้อมูล ---------------- */
let schemaReady = null;
function init(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0, upd INTEGER NOT NULL DEFAULT 0, del INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (coll, id))"),
      db.prepare("CREATE INDEX IF NOT EXISTS docs_ord ON docs (coll, del, ord DESC)"),
      db.prepare("CREATE INDEX IF NOT EXISTS docs_upd ON docs (upd)"),
      db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"),
      db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0)"),
      db.prepare("CREATE TABLE IF NOT EXISTS imgs (id TEXT PRIMARY KEY, job TEXT NOT NULL, mime TEXT NOT NULL, b64 TEXT NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS imgs_job ON imgs (job)"),
      db.prepare("CREATE TABLE IF NOT EXISTS line_users (user_id TEXT PRIMARY KEY, phone TEXT NOT NULL, linked_at INTEGER NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS line_phone ON line_users (phone)"),
      db.prepare("CREATE TABLE IF NOT EXISTS chat_threads (user_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', last_ts INTEGER NOT NULL DEFAULT 0, last_text TEXT NOT NULL DEFAULT '', unread INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL DEFAULT '', draft_flag INTEGER NOT NULL DEFAULT 0, draft_reason TEXT NOT NULL DEFAULT '', draft_for INTEGER NOT NULL DEFAULT 0)"),
      db.prepare("CREATE INDEX IF NOT EXISTS chat_last ON chat_threads (last_ts DESC)"),
      db.prepare("CREATE TABLE IF NOT EXISTS chat_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, dir TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL)"),
      db.prepare("CREATE INDEX IF NOT EXISTS chat_msgs_u ON chat_msgs (user_id, id)"),
      db.prepare("CREATE TABLE IF NOT EXISTS chat_pause (user_id TEXT PRIMARY KEY, until INTEGER NOT NULL)")
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const SEQ_BUMP = "UPDATE meta SET v = v + 1 WHERE k = 'seq'";
const UPSERT =
  "INSERT INTO docs (coll, id, data, ord, upd, del) VALUES (?1, ?2, ?3, ?4, (SELECT v FROM meta WHERE k = 'seq'), 0) " +
  "ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, ord = excluded.ord, upd = excluded.upd, del = 0";
/* นัดหมาย: 1 วันต่อ 1 คิว — เขียนทับได้เฉพาะวันที่ว่างหรือถูกยกเลิกแล้ว */
const UPSERT_BOOKING = UPSERT + " WHERE docs.del = 1 OR json_extract(docs.data, '$.cid') IS NULL";

async function getDoc(env, coll, id) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE coll = ?1 AND id = ?2 AND del = 0").bind(coll, id).first();
  return r ? JSON.parse(r.data) : null;
}

/* บันทึกเอกสาร (แยกรูปใหญ่ในใบงานไปเก็บเป็นไฟล์)
   guard=true (ใช้กับ PUT จองนัด): คืน {taken:true} ถ้าวันนั้นมีคนจองแล้ว */
async function putDoc(env, coll, id, data, guard = false) {
  const extra = [];
  if (coll === "jobs" && data && typeof data.shots === "object" && data.shots) {
    const keep = [];
    for (const k of Object.keys(data.shots)) {
      const v = data.shots[k];
      if (typeof v !== "string") { delete data.shots[k]; continue; }
      if (v.startsWith("data:image/")) {
        const cut = v.indexOf(";base64,");
        if (cut < 0) { delete data.shots[k]; continue; }
        const imgId = id + "_" + rand();
        extra.push(env.DB.prepare("INSERT INTO imgs (id, job, mime, b64) VALUES (?1, ?2, ?3, ?4)").bind(imgId, id, v.slice(5, cut), v.slice(cut + 8)));
        data.shots[k] = "/api/img/" + imgId; keep.push(imgId);
      } else if (v.startsWith("/api/img/")) keep.push(v.slice(9));
      else delete data.shots[k];
    }
    extra.push(env.DB.prepare("DELETE FROM imgs WHERE job = ?1 AND id NOT IN (" + (keep.length ? keep.map((_, i) => "?" + (i + 2)).join(",") : "''") + ")").bind(id, ...keep));
  }
  const text = JSON.stringify(data);
  if (text.length > MAX_DOC) return { ok: false, tooBig: true };
  const ord = coll === "jobs" ? Number(data && data.createdAt) || 0 : 0;
  const res = await env.DB.batch([
    env.DB.prepare(SEQ_BUMP),
    env.DB.prepare(guard && coll === "bookings" ? UPSERT_BOOKING : UPSERT).bind(coll, id, text, ord),
    ...extra
  ]);
  const changed = res[1] && res[1].meta && res[1].meta.changes;
  if (guard && coll === "bookings" && !changed) return { ok: false, taken: true };
  return { ok: true };
}

async function delDoc(env, coll, id) {
  const stmts = [
    env.DB.prepare(SEQ_BUMP),
    env.DB.prepare("UPDATE docs SET del = 1, data = '{}', upd = (SELECT v FROM meta WHERE k = 'seq') WHERE coll = ?1 AND id = ?2").bind(coll, id)
  ];
  if (coll === "jobs") stmts.push(env.DB.prepare("DELETE FROM imgs WHERE job = ?1").bind(id));
  await env.DB.batch(stmts);
}

/* ---------------- ล็อกอิน (Cloudflare Access JWT) ---------------- */
let jwks = { at: 0, keys: {} };
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const teamHost = (env) => String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

async function getKey(env, kid) {
  if (jwks.keys[kid] && Date.now() - jwks.at < 3600e3) return jwks.keys[kid];
  const r = await fetch("https://" + teamHost(env) + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("certs " + r.status);
  const body = await r.json();
  const keys = {};
  for (const jwk of body.keys || []) keys[jwk.kid] = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  jwks = { at: Date.now(), keys };
  return keys[kid] || null;
}

/* คืน {email, owner} | {error} | {bad:"เหตุผล"} (บัตรไม่ผ่าน) | null (ไม่มีบัตร) */
async function authUser(req, env) {
  if (!teamHost(env) || !env.ACCESS_AUD) return { error: "not_configured" };
  const tok = req.headers.get("cf-access-jwt-assertion");
  if (!tok) return null;
  try {
    const [h, p, s] = tok.split(".");
    const head = JSON.parse(new TextDecoder().decode(b64u(h)));
    const pay = JSON.parse(new TextDecoder().decode(b64u(p)));
    if (head.alg !== "RS256") return { bad: "alg=" + head.alg };
    const key = await getKey(env, head.kid);
    if (!key) return { bad: "no_key_for_kid" };
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
    if (!ok) return { bad: "bad_signature" };
    const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
    const want = String(env.ACCESS_AUD).trim();
    if (!aud.includes(want)) return { bad: "aud_mismatch token=" + String(aud[0]).slice(0, 6) + "(" + String(aud[0]).length + ") set=" + want.slice(0, 6) + "(" + want.length + ")" };
    if (!pay.exp || pay.exp * 1000 < Date.now()) return { bad: "expired" };
    if (pay.iss !== "https://" + teamHost(env)) return { bad: "iss_mismatch token=" + pay.iss + " set=" + teamHost(env) };
    const email = String(pay.email || "").toLowerCase();
    if (!email) return { bad: "no_email" };
    const owners = list(env.OWNER_EMAILS), staff = list(env.STAFF_EMAILS);
    const owner = owners.includes(email);
    if (staff.length && !owner && !staff.includes(email)) return { error: "forbidden" };
    return { email, owner };
  } catch (e) { return { bad: "exception " + String(e && e.message || e).slice(0, 80) + " team=" + teamHost(env) }; }
}

/* ---------------- API ---------------- */
async function readJson(req, max = 14_000_000) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error("too big"), { status: 413 });
  return JSON.parse(t);
}

async function api(req, env, url) {
  const u = await authUser(req, env);
  if (u && u.bad) {
    const cookie = req.headers.get("cookie") || "";
    return json({ error: "unauthenticated", message: "ต้องล็อกอิน", jwtHeader: true, accessCookie: /CF_Authorization=/.test(cookie), host: url.host, why: u.bad }, 401);
  }
  if (u && u.error === "not_configured") return fail(503, "not_configured", "ยังไม่ได้ตั้งค่า Cloudflare Access (ACCESS_TEAM_DOMAIN / ACCESS_AUD) ดูคู่มือ SETUP-CLOUDFLARE.md");
  if (u && u.error === "forbidden") return fail(403, "forbidden", "อีเมลนี้ยังไม่ได้รับสิทธิ์");
  if (!u) {
    /* ข้อมูลวินิจฉัย (ไม่มีความลับ): ด่าน Access ส่ง JWT มาถึงแอปหรือไม่ */
    const cookie = req.headers.get("cookie") || "";
    return json({ error: "unauthenticated", message: "ต้องล็อกอิน", jwtHeader: !!req.headers.get("cf-access-jwt-assertion"), accessCookie: /CF_Authorization=/.test(cookie), host: url.host }, 401);
  }
  await init(env.DB);
  const parts = url.pathname.split("/").slice(2);      /* /api/<a>/<b>/<c> */
  const m = req.method;

  if (parts[0] === "richmenu") {   /* ตั้งเมนูไลน์ OA อัตโนมัติ (เจ้าของเท่านั้น): เปิด /api/richmenu?run=1 */
    if (!u.owner) return fail(403, "owner_only", "เฉพาะเจ้าของร้าน");
    if (new URL(req.url).searchParams.get("run") !== "1") return json({ info: "เพิ่ม ?run=1 เพื่อสร้างและตั้งเมนูไลน์" });
    const H = { Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN };
    const W = 2500, hh = 843, cw = [833, 833, 834];
    const msgA = (t) => ({ type: "message", text: t });
    const acts = [msgA("สนใจฟิล์มกรองแสง ขอข้อมูลหน่อยครับ"), msgA("สนใจฟิล์มกันรอย PPF ขอข้อมูลหน่อยครับ"), msgA("สนใจเคลือบเซรามิค ขอข้อมูลหน่อยครับ"),
      msgA("สอบถามค่าล้างรถ/ดีเทลลิ่งหน่อยครับ"), { type: "uri", uri: "https://karnet.org/pub/" }, { type: "uri", uri: "tel:0639282291" }];
    const areas = acts.map((a, i) => ({ bounds: { x: cw.slice(0, i % 3).reduce((x, y) => x + y, 0), y: Math.floor(i / 3) * hh, width: cw[i % 3], height: hh }, action: a }));
    const r1 = await fetch("https://api.line.me/v2/bot/richmenu", { method: "POST", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ size: { width: W, height: hh * 2 }, selected: true, name: "cs-menu", chatBarText: "เมนู / สอบถามราคา", areas }) });
    if (!r1.ok) return fail(502, "line_create", await r1.text());
    const id = (await r1.json()).richMenuId;
    const img = await env.ASSETS.fetch(new Request(new URL("/richmenu.png", req.url)));
    if (!img.ok) return fail(500, "no_image", "ไม่พบรูปเมนู");
    const r2 = await fetch("https://api-data.line.me/v2/bot/richmenu/" + id + "/content", { method: "POST", headers: { ...H, "content-type": "image/png" }, body: await img.arrayBuffer() });
    if (!r2.ok) return fail(502, "line_image", await r2.text());
    const r3 = await fetch("https://api.line.me/v2/bot/user/all/richmenu/" + id, { method: "POST", headers: H });
    if (!r3.ok) return fail(502, "line_default", await r3.text());
    /* ลบเมนู cs-menu อันเก่าที่เราสร้างไว้ก่อนหน้า */
    try {
      const l = await (await fetch("https://api.line.me/v2/bot/richmenu/list", { headers: H })).json();
      for (const x of (l.richmenus || [])) if (x.name === "cs-menu" && x.richMenuId !== id) await fetch("https://api.line.me/v2/bot/richmenu/" + x.richMenuId, { method: "DELETE", headers: H });
    } catch (e) { /* ไม่เป็นไร */ }
    return json({ ok: true, richMenuId: id });
  }
  if (parts[0] === "me" && m === "GET") return json({ email: u.email, owner: u.owner });

  if (parts[0] === "sync" && m === "GET") {
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    const seq = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'seq'").first()).v;
    if (since && since >= seq) return json({ seq, changes: [] });
    const out = [];
    if (!since) {
      for (const c of Object.keys(LIMITS)) {
        const rs = await env.DB.prepare("SELECT id, data FROM docs WHERE coll = ?1 AND del = 0 ORDER BY ord DESC, id LIMIT ?2").bind(c, LIMITS[c]).all();
        for (const r of rs.results) out.push('{"c":"' + c + '","id":' + JSON.stringify(r.id) + ',"data":' + r.data + "}");
      }
    } else {
      const rs = await env.DB.prepare("SELECT coll, id, data, del FROM docs WHERE upd > ?1 ORDER BY upd").bind(since).all();
      for (const r of rs.results) out.push('{"c":"' + r.coll + '","id":' + JSON.stringify(r.id) + ',"data":' + (r.del ? "null" : r.data) + "}");
    }
    return new Response('{"seq":' + seq + ',"changes":[' + out.join(",") + "]}", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }

  if (parts[0] === "d" && COLLS.has(parts[1]) && ID_RE.test(parts[2] || "")) {
    const coll = parts[1], id = parts[2];
    if (m === "GET") {
      const d = await getDoc(env, coll, id);
      return json({ exists: !!d, data: d });
    }
    if (coll === "settings" && !u.owner) return fail(403, "owner_only", "แก้ไขได้เฉพาะเจ้าของร้าน");
    if (m === "PUT" || m === "PATCH") {
      let body;
      try { body = await readJson(req, MAX_DOC * 3); } catch (e) { return fail(e.status || 400, "bad_body", "ข้อมูลไม่ถูกต้อง"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_body", "ข้อมูลไม่ถูกต้อง");
      let data = body;
      if (m === "PATCH") {
        const cur = await getDoc(env, coll, id);
        if (!cur) return fail(404, "not_found", "ไม่พบข้อมูล");
        data = Object.assign({}, cur, body);
      }
      const r = await putDoc(env, coll, id, data, m === "PUT");
      if (r.taken) return fail(409, "taken", "วันนี้มีคนจองแล้ว");
      if (r.tooBig) return fail(413, "too_big", "ข้อมูลใหญ่เกินไป");
      return json({ ok: true });
    }
    if (m === "DELETE") { await delDoc(env, coll, id); return json({ ok: true }); }
  }

  if (parts[0] === "img" && parts[1] && m === "GET") {
    const r = await env.DB.prepare("SELECT mime, b64 FROM imgs WHERE id = ?1").bind(parts[1]).first();
    if (!r) return new Response("not found", { status: 404 });
    const bin = atob(r.b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { headers: { "content-type": r.mime, "cache-control": "private, max-age=31536000, immutable" } });
  }

  if (parts[0] === "photo" && m === "POST") return readPhoto(req, env);
  if (parts[0] === "line" && parts[1] === "push" && m === "POST") return pushLine(req, env);
  if (parts[0] === "chats") return chatsApi(req, env, parts, m);
  return fail(404, "not_found", "ไม่พบ");
}

/* ---------------- อ่านรูปด้วย Claude ---------------- */
async function readPhoto(req, env) {
  if (!env.ANTHROPIC_API_KEY) return fail(503, "no_key", "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY");
  let body;
  try { body = await readJson(req); } catch (e) { return fail(e.status || 400, "bad_body", "ข้อมูลไม่ถูกต้อง"); }
  const { prompt, images } = body || {};
  if (!prompt || !Array.isArray(images) || !images.length || images.length > 3) return fail(400, "bad_args", "ข้อมูลไม่ถูกต้อง");
  for (const b of images) if (typeof b !== "string" || b.length > 4_000_000) return fail(400, "bad_args", "รูปใหญ่เกินไป");
  const content = images.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } }));
  content.push({ type: "text", text: String(prompt).slice(0, 8000) });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL, max_tokens: 800, messages: [{ role: "user", content }] })
  });
  if (r.status === 429) return fail(429, "rate_limited", "ใช้งานถี่เกินไป");
  if (!r.ok) {
    let why = "";
    try { const ej = await r.json(); why = (ej && ej.error && (ej.error.type + ": " + ej.error.message)) || ""; } catch (e) { /* ignore */ }
    return fail(502, "ai_failed", ("AI ตอบไม่สำเร็จ " + r.status + " " + why).slice(0, 300));
  }
  const out = await r.json();
  const text = (out.content || []).map((c) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ json: null });
  try { return json({ json: JSON.parse(m[0]) }); } catch (e) { return json({ json: null }); }
}

/* ---------------- LINE ---------------- */
async function linePush(env, userId, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text: String(text).slice(0, 4900) }] })
  });
  if (!r.ok) throw new Error("LINE " + r.status + " " + (await r.text()));
}

async function pushLine(req, env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return json({ sent: false, reason: "not_configured" });
  let body;
  try { body = await readJson(req, 20000); } catch (e) { return fail(400, "bad_body", "ข้อมูลไม่ถูกต้อง"); }
  const phone = normPhone(body && body.phone), text = body && body.text;
  if (!phone || !text) return fail(400, "bad_args", "ข้อมูลไม่ครบ");
  const row = await env.DB.prepare("SELECT user_id FROM line_users WHERE phone = ?1 LIMIT 1").bind(phone).first();
  if (!row) return json({ sent: false, reason: "not_linked" });
  try { await linePush(env, row.user_id, text); } catch (e) { return json({ sent: false, reason: "line_error" }); }
  return json({ sent: true });
}


/* ---------------- แชตลูกค้า + ผู้ช่วยร่างคำตอบ (AI ร่าง พนักงานกดส่งเอง) ---------------- */
const UID_RE = /^[A-Za-z0-9]{10,64}$/;
const DRAFTS_PER_DAY = 300;

function msgText(m) {
  if (!m) return "";
  if (m.type === "text") return String(m.text || "").slice(0, 2000);
  const kinds = { image: "รูปภาพ", sticker: "สติกเกอร์", video: "วิดีโอ", audio: "ข้อความเสียง", file: "ไฟล์", location: "ตำแหน่งที่ตั้ง" };
  return "[ลูกค้าส่ง" + (kinds[m.type] || "ข้อความที่ไม่ใช่ตัวอักษร") + "]";
}

async function lineProfileName(env, uid) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/profile/" + uid, { headers: { Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN } });
    if (!r.ok) return "";
    const j = await r.json();
    return String((j && j.displayName) || "").slice(0, 80);
  } catch (e) { return ""; }
}

async function logIncoming(env, uid, text) {
  const ts = Date.now();
  const row = await env.DB.prepare("SELECT name FROM chat_threads WHERE user_id = ?1").bind(uid).first();
  const name = row && row.name ? row.name : await lineProfileName(env, uid);
  const ins = await env.DB.prepare("INSERT INTO chat_msgs (user_id, dir, text, ts) VALUES (?1, 'in', ?2, ?3)").bind(uid, text, ts).run();
  const mid = ins.meta.last_row_id;
  await env.DB.prepare(
    "INSERT INTO chat_threads (user_id, name, last_ts, last_text, unread) VALUES (?1, ?2, ?3, ?4, 1) " +
    "ON CONFLICT (user_id) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chat_threads.name END, last_ts = excluded.last_ts, last_text = excluded.last_text, unread = chat_threads.unread + 1, draft = '', draft_flag = 0, draft_reason = ''"
  ).bind(uid, name, ts, text.slice(0, 200)).run();
  return mid;
}

function thaiNow() {
  const d = new Date(Date.now() + 7 * 3600e3);
  const days = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
  return "วัน" + days[d.getUTCDay()] + "ที่ " + d.toISOString().slice(0, 10) + " เวลา " + d.toISOString().slice(11, 16) + " น. (เวลาไทย)";
}

/* สร้างร่างคำตอบจากประวัติแชต เก็บไว้ในเธรด (ไม่ส่งหาลูกค้า) คืน {ok, draft?, why?} */
async function makeDraft(env, uid, img) {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, why: "no_key" };
  const day = "drafts_" + new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES (?1, 0)").bind(day).run();
  const used = (await env.DB.prepare("SELECT v FROM meta WHERE k = ?1").bind(day).first()).v;
  if (used >= DRAFTS_PER_DAY) return { ok: false, why: "daily_limit" };
  await env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k = ?1").bind(day).run();

  const rs = await env.DB.prepare("SELECT id, dir, text, ts FROM chat_msgs WHERE user_id = ?1 ORDER BY id DESC LIMIT 14").bind(uid).all();
  const rows = rs.results.reverse();
  if (!rows.length || rows[rows.length - 1].dir !== "in") return { ok: false, why: "no_pending" };
  const lastId = rows[rows.length - 1].id;
  /* ถ้าลูกค้าเงียบไปนานก่อนทักใหม่ บอก AI ว่าเป็นการเริ่มบทสนทนาใหม่ ไม่ต้องต่อเรื่องเดิม */
  let gapNote = "";
  if (rows.length > 1) {
    const gapMin = Math.round((rows[rows.length - 1].ts - rows[rows.length - 2].ts) / 60000);
    if (gapMin >= 30) gapNote = "\n(ระบบแจ้ง: ข้อความนี้ห่างจากข้อความก่อนหน้า " + (gapMin >= 120 ? Math.round(gapMin / 60) + " ชั่วโมง" : gapMin + " นาที") + " ถือเป็นการเริ่มคุยรอบใหม่ ไม่ต้องต่อเรื่องเดิมถ้าลูกค้าแค่ทักทาย)";
  }
  /* ประวัติแชต: ฝั่งร้านใส่เป็น JSON รูปแบบเดียวกับที่ต้องการให้ตอบ ไม่งั้น AI จะเลียนแบบข้อความธรรมดา */
  const turns = [];
  for (const r of rows) {
    const role = r.dir === "in" ? "user" : "assistant";
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].parts.push(r.text);
    else turns.push({ role, parts: [r.text] });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length) return { ok: false, why: "no_pending" };
  const SUFFIX = "\n\n(ตอบเป็น JSON บรรทัดเดียวตามรูปแบบที่กำหนดเท่านั้น ห้ามมีข้อความอื่น)";
  const build = (extra) => turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (t.role !== "user") return { role: t.role, content: JSON.stringify({ reply: t.parts.join("\n"), needs_staff: false, staff_followup: false, reason: "" }) };
    const txt = t.parts.map((x) => "ข้อความลูกค้า: " + x).join("\n") + (last ? gapNote + (img ? "\n(ลูกค้าส่งรูปภาพมาตามที่แนบ ดูรูปแล้วตอบตามที่เห็นและคุยต่อเรื่องที่กำลังคุย)" : "") + SUFFIX + extra : "");
    return { role: "user", content: last && img ? [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: txt }] : txt };
  });

  let j = null, text = "", lastErr = "", useSearch = false;
  for (let attempt = 0; attempt < 3 && !j; attempt++) {
    let r;
    try { r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: env.CHAT_MODEL || env.MODEL || DEFAULT_MODEL,
        max_tokens: 4000,
        ...(useSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } : {}),
        system: [{ type: "text", text: KB, cache_control: { type: "ephemeral" } }, { type: "text", text: "ตอนนี้: " + thaiNow() }],
        messages: build(attempt ? "\nสำคัญ: ผลลัพธ์ต้องเป็น JSON ที่มีคีย์ reply, needs_staff, reason เท่านั้น เริ่มด้วย { และจบด้วย }" : "")
      })
    }); } catch (e) { lastErr = ("fetch " + (e && e.message)).slice(0, 200); break; }
    if (!r.ok) {
      let why = "";
      try { const ej = await r.json(); why = (ej && ej.error && (ej.error.type + ": " + ej.error.message)) || ""; } catch (e) { /* ignore */ }
      lastErr = ("ai " + r.status + " " + why).slice(0, 200);
      if (useSearch && (r.status === 400 || r.status === 403 || r.status === 404)) { useSearch = false; continue; }
      break;
    }
    const out = await r.json();
    text = (out.content || []).map((c) => c.text || "").join("");
    if (!text) lastErr = ("ai_empty stop=" + out.stop_reason + " types=" + (out.content || []).map((c) => c.type).join(",") + " out=" + (out.usage && out.usage.output_tokens)).slice(0, 200);
    const mm = text.match(/\{[\s\S]*\}/);
    if (mm) { try { const o = JSON.parse(mm[0]); if (o && typeof o.reply === "string") j = o; } catch (e) { /* ลองใหม่ */ } }
  }
  if (!j && !text) return { ok: false, why: lastErr || "ai_empty" };
  const reply = String(j ? j.reply : text).trim().slice(0, 4000);
  const flag = j ? (j.needs_staff ? 1 : 0) : 1;
  const reason = String((j && j.reason) || (j ? "" : "AI ตอบรูปแบบไม่ตรง ตรวจข้อความก่อนส่ง")).slice(0, 300);
  /* ถ้าระหว่างรอ AI ลูกค้าพิมพ์ข้อความใหม่ ร่างนี้เก่าแล้ว ทิ้ง */
  const res = await env.DB.prepare("UPDATE chat_threads SET draft = ?2, draft_flag = ?3, draft_reason = ?4, draft_for = ?5 WHERE user_id = ?1 AND (SELECT max(id) FROM chat_msgs WHERE user_id = ?1) = ?5")
    .bind(uid, reply, flag, reason, lastId).run();
  return { ok: true, ts: rows[rows.length - 1].ts, draft: reply, flag: !!flag, followup: !!(j && j.staff_followup && !j.needs_staff), reason, stale: !(res.meta && res.meta.changes) };
}


/* ---------------- ตอบลูกค้าอัตโนมัติ (เฉพาะเรื่องที่ AI มั่นใจและไม่เสี่ยง) ---------------- */
const HOLD_TEXT = "ขอเช็กรายละเอียดให้สักครู่นะครับ เดี๋ยวรีบตอบกลับครับ";
const AUTO_PER_HOUR = 30;

/* ข้อความยาวแยกเป็นหลายบับเบิลตามย่อหน้า (สูงสุด 4) ให้อ่านเหมือนคนพิมพ์ทีละท่อน */
function splitBubbles(text) {
  const parts = String(text).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length < 4) out.push(p);
    else out[3] += "\n\n" + p;
  }
  return (out.length ? out : [String(text)]).map((t) => ({ type: "text", text: t.slice(0, 4900) }));
}

async function lineReplyOrPush(env, replyToken, uid, text) {
  const messages = splitBubbles(text);
  if (replyToken) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN },
        body: JSON.stringify({ replyToken, messages })
      });
      if (r.ok) return;
    } catch (e) { /* ลอง push ต่อ */ }
  }
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN },
    body: JSON.stringify({ to: uid, messages })
  });
  if (!r.ok) throw new Error("LINE " + r.status + " " + (await r.text()));
}

async function autoEnabled(env) {
  const cfg = await getDoc(env, "settings", "ai");
  return !(cfg && cfg.auto === false);
}

const NEW_ROUND_MS = 30 * 60e3;

/* แจ้งเจ้าของร้านทาง LINE เมื่อ AI ตอบเองไม่ได้/ต้องมีคนดูต่อ (ตั้ง settings/ai.notify = [LINE userId]) */
async function notifyOwner(env, uid, why) {
  try {
    const cfg = await getDoc(env, "settings", "ai");
    const ids = (cfg && Array.isArray(cfg.notify) ? cfg.notify : []).filter((x) => UID_RE.test(String(x))).slice(0, 5);
    if (!ids.length) return;
    const th = await env.DB.prepare("SELECT name FROM chat_threads WHERE user_id = ?1").bind(uid).first();
    const last = await env.DB.prepare("SELECT text FROM chat_msgs WHERE user_id = ?1 AND dir = 'in' ORDER BY id DESC LIMIT 1").bind(uid).first();
    const msg = "🔔 ลูกค้าต้องให้ดูเอง\nชื่อ: " + ((th && th.name) || "ลูกค้า") + "\nถามว่า: " + String((last && last.text) || "").slice(0, 200) + "\nเหตุผล: " + String(why || "AI ไม่แน่ใจ").slice(0, 200) + "\nเปิดดูและตอบ: https://karnet.org";
    for (const id of ids) { try { await linePush(env, id, msg); } catch (e) { console.error("notify owner failed", e); } }
  } catch (e) { console.error("notify owner failed", e); }
}

async function fetchLineImage(env, id) {
  try {
    if (!id || !/^\d+$/.test(String(id))) return null;
    const r = await fetch("https://api-data.line.me/v2/bot/message/" + id + "/content", { headers: { Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN } });
    if (!r.ok) return null;
    const type = (r.headers.get("content-type") || "").split(";")[0];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > 3_500_000) return null;
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return { type, data: btoa(bin) };
  } catch (e) { return null; }
}

async function handleChat(env, uid, replyToken, kind, msgId) {
  const img = kind === "image" && env.LINE_CHANNEL_ACCESS_TOKEN ? await fetchLineImage(env, msgId) : null;
  const d = await makeDraft(env, uid, img);
  if (!d.ok && d.why && d.why !== "no_pending") {
    await env.DB.prepare("UPDATE chat_threads SET draft_flag = 1, draft_reason = ?2 WHERE user_id = ?1").bind(uid, ("AI ตอบไม่สำเร็จ: " + d.why).slice(0, 300)).run();
  }
  if (!d.ok || d.stale) return;
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !(await autoEnabled(env))) return;
  const now = Date.now();
  const pz = await env.DB.prepare("SELECT until FROM chat_pause WHERE user_id = ?1").bind(uid).first();
  if (pz && pz.until > now) return;
  const cnt = (await env.DB.prepare("SELECT count(*) AS n FROM chat_msgs WHERE user_id = ?1 AND dir IN ('auto','hold') AND ts > ?2").bind(uid, now - 3600e3).first()).n;
  if (cnt >= AUTO_PER_HOUR) {
    await env.DB.prepare("UPDATE chat_threads SET draft_flag = 1, draft_reason = ?2 WHERE user_id = ?1").bind(uid, "ตอบอัตโนมัติถึงเพดานต่อชั่วโมงแล้ว ให้ทีมงานดูต่อ").run();
    return;
  }
  /* ลูกค้าทักมารอบใหม่ (ร้าน/AI ยังไม่ได้ตอบใน 30 นาที) ต้องขึ้นต้นด้วย สวัสดีครับ เสมอ ไม่ว่าลูกค้าจะทักอะไรมา */
  const lastOut = await env.DB.prepare("SELECT max(ts) AS ts FROM chat_msgs WHERE user_id = ?1 AND dir IN ('auto','hold','out') AND ts <= ?2").bind(uid, d.ts || now).first();
  const newRound = !lastOut || !lastOut.ts || (d.ts || now) - lastOut.ts >= NEW_ROUND_MS;
  const greet = (t) => (newRound && !/^\s*สวัสดี/.test(t) ? "สวัสดีครับ " + t : t);
  if (kind === "sticker") {
    if (!newRound) return;
    const gt = "สวัสดีครับ มีอะไรให้ทางร้านช่วยดูแลรถไหมครับ";
    try { await lineReplyOrPush(env, replyToken, uid, gt); } catch (e) { console.error("auto reply failed", e); return; }
    await env.DB.prepare("INSERT INTO chat_msgs (user_id, dir, text, ts) VALUES (?1, 'auto', ?2, ?3)").bind(uid, gt, Date.now()).run();
    return;
  }
  const safe = (kind === "text" || (kind === "image" && !!img)) && !d.flag && d.draft;
  let text = safe ? greet(d.draft) : d.draft;
  if (!safe) {
    /* ต้องให้พนักงานดู: ส่งข้อความรอสั้นๆ ครั้งเดียวต่อ 10 นาที แล้วปล่อยให้พนักงานตอบต่อ */
    const recent = await env.DB.prepare("SELECT count(*) AS n FROM chat_msgs WHERE user_id = ?1 AND dir = 'hold' AND ts > ?2").bind(uid, now - 600e3).first();
    await notifyOwner(env, uid, d.reason);
    if (recent.n > 0) return;
    text = greet(HOLD_TEXT);
  }
  try { await lineReplyOrPush(env, replyToken, uid, text); } catch (e) { console.error("auto reply failed", e); return; }
  await env.DB.prepare("INSERT INTO chat_msgs (user_id, dir, text, ts) VALUES (?1, ?4, ?2, ?3)").bind(uid, text.slice(0, 4900), Date.now(), safe ? "auto" : "hold").run();
  if (safe && d.followup) await notifyOwner(env, uid, d.reason || "ลูกค้าขอคิว/นัดหมาย");
  if (safe && d.followup) {
    /* AI ตอบลูกค้าไปแล้ว แต่เรื่องนี้ (เช่น ขอคิว) ต้องให้พนักงานรับช่วงต่อ: คงสถานะ ต้องดูเอง ไว้ */
    await env.DB.prepare("UPDATE chat_threads SET draft = '', draft_flag = 1, draft_reason = ?4, unread = CASE WHEN unread > 0 THEN unread ELSE 1 END, last_text = ?2, last_ts = ?3 WHERE user_id = ?1").bind(uid, ("AI: " + text).slice(0, 200), Date.now(), (d.reason || "ลูกค้าขอคิว/นัดหมาย ให้พนักงานเช็กคิวและยืนยัน").slice(0, 300)).run();
  } else if (safe) await env.DB.prepare("UPDATE chat_threads SET draft = '', draft_flag = 0, draft_reason = '', unread = 0, last_text = ?2, last_ts = ?3 WHERE user_id = ?1").bind(uid, ("AI: " + text).slice(0, 200), Date.now()).run();
}

async function chatsApi(req, env, parts, m) {
  if (!parts[1] && m === "GET") {
    const rs = await env.DB.prepare(
      "SELECT t.user_id, t.name, t.last_ts, t.last_text, t.unread, (t.draft <> '') AS has_draft, t.draft_flag, (SELECT phone FROM line_users u WHERE u.user_id = t.user_id) AS phone, " +
      "(SELECT dir FROM chat_msgs m WHERE m.user_id = t.user_id ORDER BY m.id DESC LIMIT 1) AS last_dir " +
      "FROM chat_threads t ORDER BY t.last_ts DESC LIMIT 60").all();
    const pending = (await env.DB.prepare("SELECT count(*) AS n FROM chat_threads WHERE unread > 0 OR draft <> ''").first()).n;
    return json({ threads: rs.results, pending });
  }
  const uid = parts[1];
  if (!UID_RE.test(uid || "")) return fail(400, "bad_args", "ข้อมูลไม่ถูกต้อง");
  const th = await env.DB.prepare("SELECT t.*, (SELECT phone FROM line_users u WHERE u.user_id = t.user_id) AS phone FROM chat_threads t WHERE t.user_id = ?1").bind(uid).first();
  if (!th) return fail(404, "not_found", "ไม่พบแชต");
  if (!parts[2] && m === "GET") {
    const rs = await env.DB.prepare("SELECT id, dir, text, ts FROM chat_msgs WHERE user_id = ?1 ORDER BY id DESC LIMIT 60").bind(uid).all();
    await env.DB.prepare("UPDATE chat_threads SET unread = 0 WHERE user_id = ?1").bind(uid).run();
    return json({
      thread: { user_id: th.user_id, name: th.name, phone: th.phone || "", draft: th.draft, flag: !!th.draft_flag, reason: th.draft_reason, paused_until: ((await env.DB.prepare("SELECT until FROM chat_pause WHERE user_id = ?1").bind(uid).first()) || {}).until || 0 },
      msgs: rs.results.reverse()
    });
  }
  if (parts[2] === "send" && m === "POST") {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return fail(503, "not_configured", "ยังไม่ได้ตั้งค่า LINE");
    let body;
    try { body = await readJson(req, 20000); } catch (e) { return fail(400, "bad_body", "ข้อมูลไม่ถูกต้อง"); }
    const text = String((body && body.text) || "").trim();
    if (!text) return fail(400, "bad_args", "ข้อความว่าง");
    try { await linePush(env, uid, text); } catch (e) { return fail(502, "line_error", "ส่งเข้า LINE ไม่สำเร็จ ลูกค้าอาจบล็อกร้านอยู่"); }
    const ts = Date.now();
    await env.DB.prepare("INSERT INTO chat_msgs (user_id, dir, text, ts) VALUES (?1, 'out', ?2, ?3)").bind(uid, text.slice(0, 4900), ts).run();
    await env.DB.prepare("UPDATE chat_threads SET draft = '', draft_flag = 0, draft_reason = '', unread = 0, last_ts = ?2, last_text = ?3 WHERE user_id = ?1").bind(uid, ts, ("ร้าน: " + text).slice(0, 200)).run();
    /* พนักงานเข้ามาตอบเอง: หยุด AI ตอบอัตโนมัติในแชตนี้ 12 ชั่วโมง */
    await env.DB.prepare("INSERT INTO chat_pause (user_id, until) VALUES (?1, ?2) ON CONFLICT (user_id) DO UPDATE SET until = excluded.until").bind(uid, ts + 12 * 3600e3).run();
    return json({ sent: true });
  }
  if (parts[2] === "pause" && m === "POST") {
    let body;
    try { body = await readJson(req, 2000); } catch (e) { return fail(400, "bad_body", "ข้อมูลไม่ถูกต้อง"); }
    const hours = Math.max(0, Math.min(24 * 7, Number(body && body.hours) || 0));
    if (!hours) await env.DB.prepare("DELETE FROM chat_pause WHERE user_id = ?1").bind(uid).run();
    else await env.DB.prepare("INSERT INTO chat_pause (user_id, until) VALUES (?1, ?2) ON CONFLICT (user_id) DO UPDATE SET until = excluded.until").bind(uid, Date.now() + hours * 3600e3).run();
    return json({ ok: true });
  }
  if (parts[2] === "dismiss" && m === "POST") {
    await env.DB.prepare("UPDATE chat_threads SET draft = '', draft_flag = 0, draft_reason = '', unread = 0 WHERE user_id = ?1").bind(uid).run();
    return json({ ok: true });
  }
  if (parts[2] === "draft" && m === "POST") {
    const r = await makeDraft(env, uid);
    if (!r.ok) return fail(r.why === "no_key" ? 503 : 502, "ai_failed", r.why === "daily_limit" ? "ร่างคำตอบครบโควตารายวันแล้ว" : r.why === "no_pending" ? "ลูกค้ายังไม่ได้ส่งข้อความใหม่" : "AI ตอบไม่สำเร็จ " + (r.why || ""));
    return json({ draft: r.draft, flag: r.flag, reason: r.reason });
  }
  return fail(404, "not_found", "ไม่พบ");
}

async function lineWebhook(req, env, ctx) {
  if (req.method !== "POST") return new Response("ok");
  if (!env.LINE_CHANNEL_SECRET) return new Response("not configured", { status: 503 });
  const raw = await req.text();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expect = btoa(String.fromCharCode(...mac)), sig = req.headers.get("x-line-signature") || "";
  let diff = sig.length ^ expect.length;
  for (let i = 0; i < expect.length; i++) diff |= (sig.charCodeAt(i) || 0) ^ expect.charCodeAt(i);
  if (diff !== 0) return new Response("bad signature", { status: 401 });
  await init(env.DB);
  let events = [];
  try { events = JSON.parse(raw).events || []; } catch (e) { /* ว่าง */ }
  for (const ev of events) {
    try {
      const uid = ev.source && ev.source.userId;
      if (!uid || !ev.replyToken || (ev.source && ev.source.type && ev.source.type !== "user")) continue;
      let reply = null;
      if (ev.type === "follow") {
        reply = "ยินดีต้อนรับสู่ Corner Space\nพิมพ์เบอร์โทรที่ลงทะเบียนกับร้าน (เช่น 0812345678) เพื่อรับแจ้งเตือนนัดบริการทาง LINE";
      } else if (ev.type === "message" && ev.message) {
        const phone = ev.message.type === "text" ? normPhone(ev.message.text) : "";
        if (/^0\d{8,9}$/.test(phone)) {
          await env.DB.prepare("INSERT INTO line_users (user_id, phone, linked_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET phone = excluded.phone, linked_at = excluded.linked_at").bind(uid, phone, Date.now()).run();
          reply = "ผูกบัญชีเรียบร้อยแล้ว ร้านจะแจ้งเตือนนัดบริการให้ทาง LINE นี้ครับ/ค่ะ";
        } else {
          /* ข้อความทั่วไป: เก็บไว้ให้พนักงานดูในแอป และให้ AI ร่างคำตอบ (ไม่ส่งหาลูกค้าเอง) */
          await logIncoming(env, uid, msgText(ev.message));
          const job = handleChat(env, uid, ev.replyToken, ev.message.type, ev.message.id).catch((e) => console.error("chat failed", e));
          if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
        }
      }
      if (reply) {
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer " + env.LINE_CHANNEL_ACCESS_TOKEN },
          body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: reply }] })
        });
      }
    } catch (e) { console.error("webhook event failed", e); }
  }
  return new Response("ok");
}

/* ---------------- เตือนนัดบริการพรุ่งนี้ (ตั้ง cron ไว้ 02:00 UTC = 09:00 เวลาไทย) ---------------- */
async function dailyReminders(env) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  await init(env.DB);
  const ds = new Date(Date.now() + 7 * 3600e3 + 24 * 3600e3).toISOString().slice(0, 10);   /* พรุ่งนี้ตามเวลาไทย */
  const rs = await env.DB.prepare("SELECT id, data FROM docs WHERE coll = 'bookings' AND del = 0 AND json_extract(data, '$.date') = ?1").bind(ds).all();
  for (const r of rs.results) {
    const b = JSON.parse(r.data), phone = normPhone(b.phone);
    if (!phone || b.reminded) continue;
    const row = await env.DB.prepare("SELECT user_id FROM line_users WHERE phone = ?1 LIMIT 1").bind(phone).first();
    if (!row) continue;
    const [y, m, d] = ds.split("-");
    try {
      await linePush(env, row.user_id, "เตือนนัดบริการพรุ่งนี้ที่ Corner Space\nรถ " + [b.plate, b.car].filter(Boolean).join(" ") + "\nวันที่ " + d + "/" + m + "/" + (Number(y) + 543));
      b.reminded = true;
      await putDoc(env, "bookings", r.id, b);
    } catch (e) { console.error("reminder failed", r.id, e); }
  }
}


/* ===== ช่องสอบถามสาธารณะ (/pub) : ไม่ต้องล็อกอิน ไม่เก็บแชต ไม่เข้าถึงข้อมูลร้าน ===== */
const PUB_PER_HOUR = 15, PUB_PER_DAY = 600;
async function pubBump(env, key, cap) {
  await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES (?1, 0)").bind(key).run();
  await env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k = ?1").bind(key).run();
  const v = (await env.DB.prepare("SELECT v FROM meta WHERE k = ?1").bind(key).first()).v;
  return v <= cap;
}
async function pubAsk(req, env) {
  const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  if (req.method !== "POST") return J({ error: "method" }, 405);
  await init(env.DB);
  if (!env.ANTHROPIC_API_KEY) return J({ reply: "ระบบสอบถามออนไลน์ยังไม่พร้อม ทักไลน์ @cs2016 ได้เลยครับ" });
  let body; try { body = await req.json(); } catch (e) { return J({ error: "bad" }, 400); }
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-10)
    .map((m) => ({ role: m && m.role === "assistant" ? "assistant" : "user", text: String((m && m.text) || "").slice(0, 600) }))
    .filter((m) => m.text.trim());
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return J({ error: "bad" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "x";
  const hb = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pub|" + ip)));
  const ih = Array.from(hb.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const t = new Date(Date.now() + 7 * 3600e3).toISOString();
  if (!(await pubBump(env, "pubip_" + ih + "_" + t.slice(0, 13), PUB_PER_HOUR)) || !(await pubBump(env, "pubday_" + t.slice(0, 10), PUB_PER_DAY)))
    return J({ reply: "ตอนนี้มีคนสอบถามเยอะ รบกวนทักไลน์ @cs2016 ได้เลยครับ ทีมงานตอบให้ครับ", limited: true });
  const SUFFIX = "\n\n(ตอบเป็น JSON บรรทัดเดียวตามรูปแบบที่กำหนดเท่านั้น ห้ามมีข้อความอื่น)";
  const note = "(ระบบแจ้ง: ลูกค้าถามผ่านหน้าเว็บสอบถามสินค้า ไม่ใช่แชตไลน์ ไม่มีรูป และไม่มีทีมงานรออยู่ในแชตนี้ ตอบเรื่องสินค้า/บริการ/ราคาตามข้อมูลที่มี ห้ามบอกว่าทีมงานจะตอบในหน้านี้ ถ้าต้องให้ทีมงานช่วย ให้ชวนทักไลน์ @cs2016 หรือฝากเบอร์โทร ห้ามยืนยันคิว ห้ามให้ส่วนลด)\n";
  const messages = msgs.map((m, i) => m.role === "assistant"
    ? { role: "assistant", content: JSON.stringify({ reply: m.text, needs_staff: false, staff_followup: false, reason: "" }) }
    : { role: "user", content: (i === msgs.length - 1 ? note : "") + "ข้อความลูกค้า: " + m.text + (i === msgs.length - 1 ? SUFFIX : "") });
  let reply = "";
  for (let a = 0; a < 2 && !reply; a++) {
    let r; try { r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: env.CHAT_MODEL || env.MODEL || DEFAULT_MODEL, max_tokens: 2000,
        system: [{ type: "text", text: KB, cache_control: { type: "ephemeral" } }, { type: "text", text: "ตอนนี้: " + thaiNow() }], messages })
    }); } catch (e) { break; }
    if (!r.ok) break;
    const out = await r.json();
    const text = (out.content || []).map((c) => c.text || "").join("");
    const mm = text.match(/\{[\s\S]*\}/);
    if (mm) { try { const o = JSON.parse(mm[0]); if (o && typeof o.reply === "string") reply = o.reply.trim().slice(0, 2000); } catch (e) { /* ลองใหม่ */ } }
  }
  if (!reply) reply = "ขออภัยครับ ระบบขัดข้องชั่วคราว ทักไลน์ @cs2016 ได้เลยครับ";
  return J({ reply });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/pub/ask") return await pubAsk(req, env);
      if (url.pathname === "/line-webhook") return await lineWebhook(req, env, ctx);
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
    } catch (e) {
      console.error("error", e && e.stack || e);
      return fail(500, "server_error", "ระบบขัดข้อง ลองอีกครั้ง");
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(dailyReminders(env)); }
};

export { dailyReminders };   /* ใช้ทดสอบ */
