/* Corner Space — Cloudflare Worker
   - เสิร์ฟหน้าเว็บ (public/) และ API ข้อมูล (/api/*) เก็บใน D1
   - ล็อกอินพนักงาน: Cloudflare Access (Worker ตรวจ JWT ซ้ำอีกชั้น)
   - /api/photo  : อ่านรูปรถ/ป้ายประกันด้วย Claude (คีย์เก็บเป็น secret)
   - /api/line/push, /line-webhook : ส่ง/รับข้อความ LINE OA
   - scheduled   : ทุกวัน 09:00 เวลาไทย เตือนลูกค้าที่นัดบริการพรุ่งนี้ */

const COLLS = new Set(["jobs", "customers", "bookings", "settings"]);
const LIMITS = { jobs: 500, customers: 2000, bookings: 1000, settings: 20 };
const MAX_DOC = 1_800_000;             /* D1: 1 แถวไม่เกิน ~2MB */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MODEL = "claude-haiku-5-5";   /* ถ้าอ่านลายมือไม่แม่น ตั้งตัวแปร MODEL เป็น claude-sonnet-5-5 */

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
      db.prepare("CREATE INDEX IF NOT EXISTS line_phone ON line_users (phone)")
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

/* คืน {email, owner} | {error} | null (ไม่ได้ล็อกอิน) */
async function authUser(req, env) {
  if (!teamHost(env) || !env.ACCESS_AUD) return { error: "not_configured" };
  const tok = req.headers.get("cf-access-jwt-assertion");
  if (!tok) return null;
  try {
    const [h, p, s] = tok.split(".");
    const head = JSON.parse(new TextDecoder().decode(b64u(h)));
    const pay = JSON.parse(new TextDecoder().decode(b64u(p)));
    if (head.alg !== "RS256") return null;
    const key = await getKey(env, head.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
    if (!ok) return null;
    const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!pay.exp || pay.exp * 1000 < Date.now()) return null;
    if (pay.iss !== "https://" + teamHost(env)) return null;
    const email = String(pay.email || "").toLowerCase();
    if (!email) return null;
    const owners = list(env.OWNER_EMAILS), staff = list(env.STAFF_EMAILS);
    const owner = owners.includes(email);
    if (staff.length && !owner && !staff.includes(email)) return { error: "forbidden" };
    return { email, owner };
  } catch (e) { return null; }
}

/* ---------------- API ---------------- */
async function readJson(req, max = 14_000_000) {
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error("too big"), { status: 413 });
  return JSON.parse(t);
}

async function api(req, env, url) {
  const u = await authUser(req, env);
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
  if (!r.ok) return fail(502, "ai_failed", "AI ตอบไม่สำเร็จ " + r.status);
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

async function lineWebhook(req, env) {
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
      if (!uid || !ev.replyToken) continue;
      let reply = null;
      if (ev.type === "follow") {
        reply = "ยินดีต้อนรับสู่ Corner Space\nพิมพ์เบอร์โทรที่ลงทะเบียนกับร้าน (เช่น 0812345678) เพื่อรับแจ้งเตือนนัดบริการทาง LINE";
      } else if (ev.type === "message" && ev.message && ev.message.type === "text") {
        const phone = normPhone(ev.message.text);
        if (/^0\d{8,9}$/.test(phone)) {
          await env.DB.prepare("INSERT INTO line_users (user_id, phone, linked_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET phone = excluded.phone, linked_at = excluded.linked_at").bind(uid, phone, Date.now()).run();
          reply = "ผูกบัญชีเรียบร้อยแล้ว ร้านจะแจ้งเตือนนัดบริการให้ทาง LINE นี้ครับ/ค่ะ";
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/line-webhook") return await lineWebhook(req, env);
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
