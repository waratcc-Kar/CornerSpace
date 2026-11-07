/* Cloud Functions ของ Corner Space
   - readPhoto : อ่านรูปรถ/ป้ายประกันด้วย Claude (คีย์เก็บเป็น secret ไม่อยู่ในหน้าเว็บ)
   - pushLine  : พนักงานกดส่งข้อความเข้า LINE ของลูกค้า
   - lineWebhook : รับข้อความจาก LINE OA (ลูกค้าพิมพ์เบอร์โทรเพื่อผูกบัญชี)
   - dailyReminders : ทุกวัน 09:00 เตือนลูกค้าที่นัดบริการวันพรุ่งนี้ */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const REGION = "asia-southeast1";
const ANTHROPIC_KEY = defineSecret("ANTHROPIC_API_KEY");
const LINE_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_SECRET = defineSecret("LINE_CHANNEL_SECRET");

/* รุ่น AI ที่ใช้อ่านรูป: ถ้าอ่านลายมือบนป้ายไม่แม่น ให้เปลี่ยนเป็นรุ่นที่ใหญ่กว่า (เช่น claude-sonnet-5-5) */
const MODEL = "claude-haiku-5-5";

async function requireStaff(req) {
  if (!req.auth || !req.auth.token || !req.auth.token.email) throw new HttpsError("unauthenticated", "ต้องล็อกอิน");
  const snap = await db.doc("config/access").get();
  const a = snap.exists ? snap.data() : {};
  const em = String(req.auth.token.email).toLowerCase();
  const lc = (l) => (l || []).map((x) => String(x).toLowerCase());
  if (!lc(a.owners).includes(em) && !lc(a.staff).includes(em)) throw new HttpsError("permission-denied", "ไม่มีสิทธิ์");
}

const normPhone = (p) => String(p || "").replace(/\D/g, "").replace(/^66/, "0");

/* ---------- อ่านรูป ---------- */
exports.readPhoto = onCall({ region: REGION, secrets: [ANTHROPIC_KEY], timeoutSeconds: 60, memory: "512MiB", maxInstances: 5 }, async (req) => {
  await requireStaff(req);
  const { prompt, images } = req.data || {};
  if (!prompt || !Array.isArray(images) || !images.length || images.length > 3) throw new HttpsError("invalid-argument", "ข้อมูลไม่ถูกต้อง");
  for (const b of images) if (typeof b !== "string" || b.length > 4_000_000) throw new HttpsError("invalid-argument", "รูปใหญ่เกินไป");
  const content = images.map((b) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } }));
  content.push({ type: "text", text: String(prompt).slice(0, 8000) });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY.value(), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, messages: [{ role: "user", content }] })
  });
  if (r.status === 429) throw new HttpsError("resource-exhausted", "ใช้งานถี่เกินไป");
  if (!r.ok) throw new HttpsError("internal", "AI ตอบไม่สำเร็จ " + r.status);
  const out = await r.json();
  const text = (out.content || []).map((c) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { json: null };
  try { return { json: JSON.parse(m[0]) }; } catch (e) { return { json: null }; }
});

/* ---------- LINE ---------- */
async function linePush(userId, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + LINE_TOKEN.value() },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text: String(text).slice(0, 4900) }] })
  });
  if (!r.ok) throw new Error("LINE " + r.status + " " + (await r.text()));
}

exports.pushLine = onCall({ region: REGION, secrets: [LINE_TOKEN], maxInstances: 5 }, async (req) => {
  await requireStaff(req);
  const phone = normPhone(req.data && req.data.phone), text = req.data && req.data.text;
  if (!phone || !text) throw new HttpsError("invalid-argument", "ข้อมูลไม่ครบ");
  const q = await db.collection("lineUsers").where("phone", "==", phone).limit(1).get();
  if (q.empty) return { sent: false, reason: "not_linked" };
  await linePush(q.docs[0].id, text);
  return { sent: true };
});

exports.lineWebhook = onRequest({ region: REGION, secrets: [LINE_TOKEN, LINE_SECRET], maxInstances: 5 }, async (req, res) => {
  const sig = req.get("x-line-signature") || "";
  const expect = crypto.createHmac("sha256", LINE_SECRET.value()).update(req.rawBody).digest("base64");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) { res.status(401).send("bad signature"); return; }
  const events = (req.body && req.body.events) || [];
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
          await db.doc("lineUsers/" + uid).set({ phone, linkedAt: Date.now() });
          reply = "ผูกบัญชีเรียบร้อยแล้ว ร้านจะแจ้งเตือนนัดบริการให้ทาง LINE นี้ครับ/ค่ะ";
        }
      }
      if (reply) {
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer " + LINE_TOKEN.value() },
          body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: reply }] })
        });
      }
    } catch (e) { console.error("webhook event failed", e); }
  }
  res.status(200).send("ok");
});

/* ---------- เตือนนัดบริการวันพรุ่งนี้ (09:00 เวลาไทย) ---------- */
exports.dailyReminders = onSchedule({ schedule: "0 9 * * *", timeZone: "Asia/Bangkok", region: REGION, secrets: [LINE_TOKEN] }, async () => {
  const t = new Date(Date.now() + 7 * 3600e3 + 24 * 3600e3);   /* พรุ่งนี้ตามเวลาไทย */
  const ds = t.toISOString().slice(0, 10);
  const bk = await db.collection("bookings").where("date", "==", ds).get();
  for (const d of bk.docs) {
    const b = d.data();
    const phone = normPhone(b.phone);
    if (!phone || b.reminded) continue;
    const q = await db.collection("lineUsers").where("phone", "==", phone).limit(1).get();
    if (q.empty) continue;
    const [y, m, dd] = ds.split("-");
    try {
      await linePush(q.docs[0].id, "เตือนนัดบริการพรุ่งนี้ที่ Corner Space\nรถ " + [b.plate, b.car].filter(Boolean).join(" ") + "\nวันที่ " + dd + "/" + m + "/" + (Number(y) + 543));
      await d.ref.update({ reminded: true });
    } catch (e) { console.error("reminder failed", d.id, e); }
  }
});
