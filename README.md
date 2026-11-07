# Corner Space

ระบบรับรถและจัดการงานคิว สำหรับร้าน Corner Space (คาร์ดีเทลลิ่ง ฟิล์มกรองแสง ฟิล์มใสกันรอย)

- `public/` : เว็บแอป (index.html ไฟล์เดียว + ตัวเชื่อม Firebase `shim.js` + `config.js`)
- `functions/` : Cloud Functions (อ่านรูปด้วย Claude, ส่ง/รับ LINE, เตือนนัดบริการ)
- `firestore.rules` : กฎความปลอดภัย (พนักงานในรายชื่อเท่านั้น, ราคาแก้ได้เฉพาะเจ้าของ)
- `SETUP.md` : **คู่มือตั้งค่าและนำขึ้นระบบ (เริ่มที่นี่)**

LINE OA ของร้าน: @cs2016 (เพิ่มเพื่อน: https://line.me/R/ti/p/%40cs2016)
