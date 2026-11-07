# คู่มือตั้งค่า Corner Space (เวอร์ชันเว็บของร้านเอง)

ใช้เวลาประมาณ 1-2 ชั่วโมงถ้าทำครั้งแรก ถ้าไม่สะดวก ให้ช่างเว็บหรือคนที่คุ้นกับคอมพิวเตอร์ทำตามคู่มือนี้แทน แล้วคุณเป็นคนสมัครบัญชีและส่งรหัสให้เขา

ระบบประกอบด้วย
- **เว็บแอป** (โฟลเดอร์ `public/`) เปิดจากลิงก์เดียว พนักงานล็อกอินด้วยอีเมลและรหัสผ่าน
- **ฐานข้อมูลกลาง** (Firestore) ทุกเครื่องเห็นคิวเดียวกัน
- **Cloud Functions** (โฟลเดอร์ `functions/`) อ่านรูปด้วย Claude, ส่งข้อความ LINE, เตือนนัดบริการ

## 0) สิ่งที่ต้องมี
- บัญชี Google (สำหรับ Firebase)
- บัตรเครดิต/เดบิต (Firebase ต้องผูกบัตรเพื่อใช้ฟังก์ชัน แต่ร้านขนาดนี้ใช้ไม่เกินโควต้าฟรีส่วนใหญ่ ดูข้อ 9 เรื่องตั้งวงเงิน)
- บัญชี LINE Official Account ของร้านที่มีอยู่แล้ว
- คอมพิวเตอร์ที่ติดตั้ง Node.js (https://nodejs.org เลือกรุ่น LTS)

## 1) สร้างโปรเจกต์ Firebase
1. เปิด https://console.firebase.google.com แล้วกด **Create a project** ตั้งชื่อ เช่น `corner-space`
2. ปิด Google Analytics ได้ (ไม่จำเป็น)
3. เมนูซ้าย **Build > Firestore Database > Create database** เลือกโหมด **Production**, location **asia-southeast1 (Singapore)**
4. เมนูซ้าย **Build > Authentication > Get started** เปิด **Email/Password**
5. มุมซ้ายล่างกด **Upgrade** เลือกแผน **Blaze** (จ่ายตามการใช้งาน) แล้วตั้ง **Budget alert** เช่น 300 บาทต่อเดือน

## 2) เพิ่มพนักงานและกำหนดเจ้าของร้าน
1. **Authentication > Users > Add user** เพิ่มอีเมลและรหัสผ่านของเจ้าของร้านและพนักงานแต่ละคน
2. **Firestore Database > Start collection** ตั้ง Collection ID เป็น `config` แล้วสร้างเอกสาร Document ID เป็น `access` ใส่ 2 ฟิลด์ (ชนิด array ของ string) **อีเมลพิมพ์เล็กทั้งหมด**
   - `owners` : อีเมลเจ้าของร้าน (คนที่แก้ราคาได้)
   - `staff` : อีเมลพนักงาน
3. พนักงานที่อีเมลไม่อยู่ในรายชื่อนี้จะเข้าระบบไม่ได้ ถ้าจะเพิ่มหรือตัดสิทธิ์ ให้แก้ที่เอกสารนี้

## 3) ใส่ค่าตั้งต้นของเว็บแอป
1. **Project settings (ไอคอนเฟือง) > General > Your apps > ไอคอน `</>` (Web)** ตั้งชื่อแอป แล้วคัดลอกค่า `apiKey`, `authDomain`, `projectId`, `appId`
2. เปิดไฟล์ `public/config.js` ใส่ค่าเหล่านั้นแทนข้อความตัวอย่าง
3. เปิดไฟล์ `.firebaserc` แก้ `YOUR-PROJECT` เป็น `projectId` ของคุณ

## 4) ขอคีย์ Claude API (ใช้อ่านรูปรถและป้ายประกัน)
1. สมัครที่ https://console.anthropic.com แล้วเติมเครดิตเล็กน้อย
2. **API keys > Create key** คัดลอกเก็บไว้ (อย่าส่งในแชทหรือใส่ในไฟล์บน GitHub)
3. ตั้ง **spend limit** รายเดือนในหน้า Billing/Limits เพื่อกันค่าใช้จ่ายเกิน

## 5) ตั้งค่า LINE
1. เปิด https://developers.line.biz/console ล็อกอินด้วยบัญชีเดียวกับ LINE OA
2. สร้าง Provider แล้วเปิดใช้ **Messaging API** กับบัญชี LINE OA ของร้าน (ในหน้า LINE Official Account Manager > Settings > Messaging API > Enable)
3. ในหน้า channel จดค่า 2 อย่าง
   - **Channel secret** (แท็บ Basic settings)
   - **Channel access token (long-lived)** (แท็บ Messaging API กด Issue)
4. **Webhook URL** ตั้งเป็น `https://<projectId>.web.app/line-webhook` แล้วเปิด **Use webhook** (ทำหลังข้อ 6 เสร็จแล้ว)
5. ใน LINE Official Account Manager ปิด **Auto-reply messages** ถ้าไม่อยากให้ตอบซ้ำกับระบบ

## 6) นำขึ้นระบบ (ทำที่คอมพิวเตอร์)
เปิด Terminal (Mac) หรือ Command Prompt (Windows) ไปที่โฟลเดอร์โปรเจกต์นี้ แล้วรันทีละบรรทัด
```
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase deploy
```
แต่ละคำสั่ง `secrets:set` จะให้วางค่าที่จดไว้ จบแล้วจะได้ลิงก์ `https://<projectId>.web.app` นั่นคือลิงก์ที่พนักงานใช้ (เก็บเป็นไอคอนบนหน้าจอมือถือได้)

## 7) ทดสอบก่อนใช้จริง
- [ ] เปิดลิงก์ ล็อกอินด้วยอีเมลพนักงาน เข้าได้
- [ ] ล็อกอินด้วยอีเมลที่ไม่อยู่ใน `config/access` ต้องเข้าไม่ได้
- [ ] ถ่ายรูปรถ ระบบกรอกยี่ห้อ รุ่น ทะเบียนให้
- [ ] บันทึกใบรับรถ เปิดจากอีกเครื่องแล้วเห็นคิวเดียวกัน
- [ ] ล็อกอินด้วยอีเมลพนักงาน หน้าราคาแก้ไม่ได้ (เจ้าของแก้ได้)
- [ ] ใช้โทรศัพท์ของคุณเอง เพิ่ม LINE OA เป็นเพื่อน พิมพ์เบอร์โทรของคุณในแชท ต้องได้ข้อความ "ผูกบัญชีเรียบร้อย"
- [ ] สร้างลูกค้าด้วยเบอร์นั้น กดปุ่ม "ส่งเข้า LINE ลูกค้า" ต้องเด้งเข้า LINE

## 8) วิธีที่ลูกค้าผูก LINE กับร้าน
ลูกค้าเพิ่ม LINE OA ของร้านเป็นเพื่อน แล้วพิมพ์เบอร์โทรที่ใช้ลงทะเบียนกับร้านในแชท ระบบจะจำคู่เบอร์กับบัญชี LINE จากนั้นร้านส่งข้อความหาลูกค้าคนนี้ได้ และระบบเตือนนัดบริการวันพรุ่งนี้ให้เองทุกวัน 09:00
ลูกค้าที่ยังไม่ผูก LINE ปุ่มส่งจะแจ้งว่ายังไม่ได้ผูก ให้ใช้ปุ่ม "คัดลอกส่ง LINE" แทน

## 9) ค่าใช้จ่ายและความปลอดภัย
- ประมาณการเดือนละ 200 คัน: Firebase ส่วนใหญ่อยู่ในโควต้าฟรี, Claude API ราว 10-30 บาท, LINE แผน Free ให้ 300 ข้อความต่อเดือน (ตรวจราคาล่าสุดกับเว็บไซต์ของแต่ละเจ้า)
- ตั้ง Budget alert ใน Firebase และ spend limit ใน Anthropic
- ห้ามใส่ API key ใน `config.js` หรือไฟล์ใดๆ ใน GitHub คีย์ Claude และ LINE เก็บเป็น secret ของ Firebase เท่านั้น (ค่าใน `config.js` เป็นค่าที่เปิดเผยได้ตามปกติของ Firebase ความปลอดภัยอยู่ที่ไฟล์ `firestore.rules`)

## 10) ข้อจำกัดของเวอร์ชันนี้
- ลูกค้ายังจองคิวเองผ่าน LINE ไม่ได้ (พนักงานจองให้ในแอป แล้วระบบแจ้งยืนยันและเตือน) การจองเองผ่าน LINE (LIFF) เป็นขั้นถัดไป
- รูปทั้งหมดเก็บในเอกสารใบงานโดยตรง (ย่อรูปแล้ว) ถ้าใบงานหนึ่งใบมีรูปมากเกิน 1 MB จะบันทึกไม่ได้
- ข้อมูลจากเวอร์ชันใน Claude ไม่ถูกย้ายมาอัตโนมัติ ให้ส่งออกไฟล์ CSV เก็บไว้ก่อน
- ผมยังไม่ได้ทดสอบกับ Firebase และ LINE จริง (ทดสอบแต่ตัวแอปกับตัวจำลอง) รอบแรกที่ตั้งค่าอาจต้องแก้เล็กน้อย ถ้าติดตรงไหนให้ส่งข้อความผิดพลาดมา
