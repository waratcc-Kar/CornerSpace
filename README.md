# Corner Space

ระบบรับรถ คิวงาน นัดบริการ ฟิล์มกรองแสง/PPF/คาร์แคร์ของร้าน Corner Space (LINE OA @cs2016)

- หน้าเว็บ: `public/` (ไฟล์เดียว `index.html` + `shim.js`)
- หลังบ้าน: `src/worker.js` — Cloudflare Worker + ฐานข้อมูล D1
  - ล็อกอินพนักงานด้วย Cloudflare Access (รหัสทางอีเมล) และ Worker ตรวจ JWT ซ้ำ
  - อ่านรูปรถ/ป้ายประกันด้วย Claude (คีย์เป็น secret ไม่อยู่ในหน้าเว็บ)
  - ส่งข้อความ/รับ webhook ของ LINE OA และเตือนนัดทุกวัน 09:00 เวลาไทย
- ตั้งค่าตามขั้นตอนใน **[SETUP-CLOUDFLARE.md](SETUP-CLOUDFLARE.md)** (ไม่ต้องใช้คำสั่ง เชื่อม GitHub แล้วกดตามหน้าเว็บ)

ชุด Firebase รุ่นก่อนหน้าอยู่ใน git history (commit `f9b957d`) ไม่ได้ใช้แล้ว
