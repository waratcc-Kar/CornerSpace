# คู่มือตั้งค่า Corner Space บน Cloudflare

ทำครั้งเดียว ใช้เวลาประมาณ 45–60 นาที **ไม่ต้องรันคำสั่งบนคอมพิวเตอร์** ทุกอย่างทำผ่านหน้าเว็บ
(ชื่อเมนูของ Cloudflare/LINE อาจต่างจากในคู่มือเล็กน้อย เพราะเขาปรับหน้าตาบ่อย ให้หาเมนูที่ความหมายใกล้เคียงกัน)

ที่ต้องมี: บัญชี Cloudflare + โดเมน (เช่น `karnet.org`), repo นี้บน GitHub, LINE OA ของร้าน, คีย์ Claude API

ผลลัพธ์: พนักงานเปิด `https://cs.karnet.org` (ชื่อย่อยตั้งเองได้) → ใส่อีเมล → รับรหัส 6 หลักทางอีเมล → ใช้งานได้ ข้อมูลทุกเครื่องตรงกัน

---

## 1) สร้างฐานข้อมูล (D1)

> ✅ สร้างไว้แล้วชื่อ `cornerspace` และใส่ ID ใน `wrangler.jsonc` แล้ว ข้ามไปข้อ 2 ได้เลย (ข้อความด้านล่างไว้ใช้ถ้าต้องสร้างใหม่)

1. เข้า dash.cloudflare.com → เมนูซ้าย **Storage & databases → D1 SQL database** → **Create database**
2. ตั้งชื่อ `cornerspace` เลือกพื้นที่ใกล้ไทย (Asia-Pacific) → Create
3. คัดลอก **Database ID** (ข้อความยาวๆ หน้าฐานข้อมูล)
4. ไปที่ repo บน GitHub → เปิดไฟล์ `wrangler.jsonc` → กดไอคอนดินสอ (Edit) → แทนที่ข้อความ `ใส่-database-id-จาก-Cloudflare` ด้วย ID ที่คัดลอก (คงเครื่องหมายคำพูดไว้) → **Commit changes**

ตารางข้อมูลระบบสร้างให้เองตอนใช้งานครั้งแรก ไม่ต้องทำอะไรเพิ่ม

## 2) นำแอปขึ้นระบบ (เชื่อม GitHub)

1. Cloudflare → **Workers & Pages → Create → Import a repository** (หรือ Connect to Git) → อนุญาต GitHub → เลือก repo `CornerSpace`
2. ชื่อโปรเจกต์: `corner-space` (ต้องตรงกับ `name` ใน `wrangler.jsonc`; ถ้ามี Worker ชื่อนี้อยู่แล้วให้เปิดอันเดิม แล้วไปที่ Settings → Builds → Connect เลือก repo)
3. ช่อง Build command เว้นว่าง ส่วน Deploy command ใช้ค่าเริ่มต้น (`npx wrangler deploy`) → **Save and Deploy**
4. รอจนขึ้นว่า Deployed จะได้ลิงก์ `corner-space.<ชื่อ>.workers.dev` (ตอนนี้ยังเปิดใช้ไม่ได้ เพราะยังไม่ได้ตั้งล็อกอิน ทำข้อ 3–4 ต่อ)

หลังจากนี้ทุกครั้งที่แก้ไฟล์ใน GitHub ระบบจะนำขึ้นใหม่ให้อัตโนมัติ

## 3) ผูกชื่อเว็บ (โดเมน)

Worker `corner-space` → **Settings → Domains & Routes → Add → Custom domain** → ใส่ `cs.karnet.org` → Add
(ใช้ชื่ออะไรก็ได้ที่เป็นของโดเมนเรา เช่น `app.karnet.org`)

จากนั้นที่หัวข้อเดียวกัน หา **workers.dev** แล้วกด **Disable** เพื่อปิดทางเข้าอื่น ให้เหลือเฉพาะชื่อเว็บของร้าน

## 4) ตั้งล็อกอินพนักงาน (Cloudflare Access, ฟรี)

1. Cloudflare → **Zero Trust** (ครั้งแรกจะให้ตั้งชื่อทีม เช่น `cornerspace` และเลือกแพลน **Free**)
   - จดไว้: **Team domain** = `ชื่อทีม.cloudflareaccess.com` (ดูได้ที่ Settings → General)
2. **Access → Applications → Add an application → Self-hosted**
   - Application name: `Corner Space`
   - Public hostname: `cs.karnet.org` (ช่อง path เว้นว่าง)
   - Policy: ตั้งชื่อ `พนักงาน`, Action = **Allow**, Include → **Emails** → ใส่อีเมลของเจ้าของและพนักงานทุกคน (ใครไม่อยู่ในรายการจะเข้าไม่ได้)
   - Login methods: เปิด **One-time PIN** → Save
3. เปิดแอปพลิเคชันที่เพิ่งสร้าง → คัดลอก **Application Audience (AUD) Tag** (ข้อความยาวๆ) เก็บไว้ใช้ข้อ 5
4. สร้างแอปพลิเคชันที่สองเพื่อ "เปิดทางให้ LINE ส่งข้อความเข้าระบบ" (ถ้าข้ามข้อนี้ LINE จะส่งเข้ามาไม่ได้)
   - Add an application → Self-hosted → ชื่อ `Corner Space LINE webhook`
   - Public hostname: `cs.karnet.org` และ **Path: `line-webhook`**
   - Policy: Action = **Bypass**, Include → **Everyone** → Save

## 5) ใส่รหัสและค่าตั้งต้น

Worker `corner-space` → **Settings → Variables and Secrets → Add** (เลือกชนิด **Secret** ทุกตัว) แล้วกด **Deploy** ตอนท้าย

| ชื่อ | ค่า |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `ชื่อทีม.cloudflareaccess.com` (จากข้อ 4.1) |
| `ACCESS_AUD` | AUD Tag (จากข้อ 4.3) |
| `OWNER_EMAILS` | อีเมลเจ้าของร้าน คั่นหลายคนด้วยคอมมา — **คนในรายการนี้เท่านั้นที่แก้ราคาได้** |
| `ANTHROPIC_API_KEY` | คีย์จาก console.anthropic.com → API Keys (เติมเครดิตเริ่มต้นราว 5 ดอลลาร์) |
| `LINE_CHANNEL_SECRET` | จากข้อ 6 |
| `LINE_CHANNEL_ACCESS_TOKEN` | จากข้อ 6 |
| `STAFF_EMAILS` (ไม่บังคับ) | ถ้าใส่ จะอนุญาตเฉพาะอีเมลในรายการนี้ + เจ้าของ ถ้าไม่ใส่ ใครผ่านด่านล็อกอินของข้อ 4 ได้ก็ใช้ได้ |
| `MODEL` (ไม่บังคับ) | ค่าเริ่มต้น `claude-haiku-5-5` ถ้าอ่านลายมือบนป้ายประกันไม่แม่น ลองเปลี่ยนเป็น `claude-sonnet-5-5` |

ยังไม่มีค่า LINE ก็ใส่ที่เหลือก่อนได้ ระบบรับรถและคิวงานใช้ได้ทันที ส่วน LINE ค่อยตามมา

## 6) เชื่อม LINE OA @cs2016

1. เข้า LINE Official Account Manager ของร้าน → **Settings → Messaging API → Enable Messaging API** (เลือก/สร้าง Provider)
2. เข้า developers.line.biz → Console → เลือก Provider/Channel ของร้าน
   - แท็บ **Basic settings** → คัดลอก **Channel secret**
   - แท็บ **Messaging API** → ท้ายหน้า **Channel access token (long-lived)** → กด Issue → คัดลอก
   - ใส่ทั้งสองค่าลงข้อ 5
3. แท็บ **Messaging API** → **Webhook URL** ใส่ `https://cs.karnet.org/line-webhook` → **Update** → กด **Verify** (ต้องขึ้น Success) → เปิด **Use webhook**
4. ใน LINE OA Manager → Settings → Response settings: **ปิด** "Auto-reply messages" (ข้อความตอบกลับอัตโนมัติ) เพื่อไม่ให้ซ้ำกับระบบ

ลูกค้าผูก LINE อย่างไร: เพิ่มเพื่อน @cs2016 → ระบบทักทาย → ลูกค้า**พิมพ์เบอร์โทรที่ลงทะเบียนกับร้าน** → ระบบผูกบัญชีให้ จากนั้นพนักงานกด "ส่งเข้า LINE ลูกค้า" ในใบงาน/นัดบริการได้ และระบบเตือนนัดให้เองทุกวัน 09:00 (เตือนล่วงหน้า 1 วัน)

## 7) ทดลองใช้

1. เปิด `https://cs.karnet.org` → ใส่อีเมลพนักงาน → รับรหัสทางอีเมล → เข้าแอป
2. ลองถ่ายรูปรถ → ระบบควรกรอกยี่ห้อ/รุ่น/ทะเบียนให้ → บันทึก → ปิดแล้วเปิดใหม่ข้อมูลต้องยังอยู่
3. เปิดจากอีกเครื่อง ต้องเห็นใบงานเดียวกัน
4. ใช้บัญชีที่ไม่ใช่เจ้าของ เข้าหน้า "ราคา" ต้องแก้ไม่ได้
5. ทดสอบ LINE ด้วยเบอร์ตัวเอง (เพิ่มเพื่อน → พิมพ์เบอร์ → สร้างใบงานด้วยเบอร์นั้น → กดส่งเข้า LINE)

## เพิ่ม/ลบพนักงาน

Zero Trust → Access → Applications → `Corner Space` → Policies → แก้รายการอีเมล (และ `STAFF_EMAILS` ถ้าตั้งไว้)

## ถ้ามีปัญหา

| อาการ | สาเหตุที่พบบ่อย |
|---|---|
| หน้าขึ้น "ยังไม่ได้ตั้งค่า Cloudflare Access" | ยังไม่ใส่ `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` หรือยังไม่กด Deploy หลังใส่ |
| ล็อกอินแล้วขึ้น "เซสชันหมดอายุ" ตลอด | `ACCESS_AUD` ผิด (ต้องเป็นของแอปพลิเคชันหลัก ไม่ใช่ของ webhook) หรือ Team domain พิมพ์ผิด |
| รหัสไม่ถึงอีเมล | อีเมลนั้นไม่อยู่ในรายการของ Policy (ข้อ 4) เช็คกล่องสแปมด้วย |
| LINE Verify ไม่ผ่าน | ยังไม่ได้ทำข้อ 4.4 (Bypass) หรือ `LINE_CHANNEL_SECRET` ผิด |
| กดส่ง LINE แล้วขึ้น "ลูกค้ายังไม่ได้ผูก LINE" | ลูกค้ายังไม่ได้พิมพ์เบอร์ในแชท หรือพิมพ์คนละเบอร์กับที่ลงทะเบียน |
| ถ่ายรูปแล้วไม่กรอกให้ | ยังไม่ใส่ `ANTHROPIC_API_KEY`/เครดิตหมด หรือแพลนฟรีของ Workers จำกัดเวลาประมวลผลต่อคำขอ ถ้าเกิดซ้ำบ่อยให้อัปเกรด Workers เป็นแพลนเสียเงินระดับเริ่มต้น (ราว 5 ดอลลาร์/เดือน ตรวจราคาล่าสุดที่ Cloudflare) |

## ค่าใช้จ่าย (ประมาณ)

รับรถ 200 คัน/เดือน แจ้งเตือนไม่เกิน 30 คน: Cloudflare Workers/D1/Access ตามแพลนฟรีน่าจะพอ (ควรเช็คโควตาล่าสุด), ค่า AI อ่านรูปหลักสิบบาท/เดือน, LINE แพ็กเกจฟรีส่งได้จำกัดต่อเดือน (ตรวจเงื่อนไขล่าสุดกับ LINE)

## ข้อจำกัดที่ควรรู้

- ข้อมูลอัปเดตข้ามเครื่องด้วยการเช็คทุก ~5 วินาที ไม่ใช่ทันที
- ลูกค้าจองคิวเองผ่าน LINE ยังไม่มี (ตอนนี้พนักงานเป็นคนบันทึกนัด แล้วระบบแจ้งเตือนทาง LINE)
- ทดสอบกับของจำลองแล้ว แต่ยังไม่เคยรันกับบัญชี Cloudflare/LINE จริง หากขั้นไหนไม่ตรงกับคู่มือ ให้ส่งภาพหน้าจอมาดูได้
