# TEST_CHECKLIST

เช็กลิสต์นี้ใช้สำหรับทดสอบระบบ `Koyeb1-ACDC-Core`, `Koyeb0-AI-Gateway`, LINE workflow และ `ACDC-Operations-Frontend`

## 1. User Setup

ใช้สำหรับเตรียมข้อมูลก่อนเริ่มทดสอบ

- [ ] มี user อย่างน้อย 1 คนเป็น `BOSS`
- [ ] มี user อย่างน้อย 1 คนเป็น `SECRETARY`
- [ ] มี user อย่างน้อย 1 คนเป็น `NYK` หรือ `NKB` หรือ `NPK` หรือ `NNG`
- [ ] ทุก user ที่จะทดสอบมี `line_user_id` อยู่ในระบบแล้ว
- [ ] user ที่จะใช้ทดสอบมองเห็นได้ใน dashboard table

## 2. Frontend

ใช้สำหรับทดสอบ `ACDC-Operations-Frontend`

- [ ] login เข้า frontend ได้
- [ ] dashboard โหลด user table ได้
- [ ] เปลี่ยน role จากหน้า dashboard ได้
- [ ] หน้า calendar โหลดข้อมูลได้
- [ ] create event จากหน้า calendar ได้
- [ ] delete event จากหน้า calendar ได้

## 3. LINE Quick Actions

ใช้สำหรับทดสอบ quick action ที่ไม่ควร fallback เข้า AI

- [ ] `ตารางวันนี้`
- [ ] `งานพรุ่งนี้`
- [ ] `งานสัปดาห์หน้า`
- [ ] `จันทร์หน้า`
- [ ] `จันทร์หน้า 0800 ไปงานแต่ง`
- [ ] `ขอการ์ดวันนี้`
- [ ] คำสั่งข้างต้นไม่หลุดเข้า AI โดยไม่จำเป็น

## 4. AI Mode

ใช้สำหรับทดสอบ explicit AI mode

- [ ] พิมพ์ `AI ช่วยสรุปงานวันนี้`
- [ ] ระบบเข้า AI mode
- [ ] ข้อความตอบกลับมีปุ่ม `Exit`
- [ ] พิมพ์ `exit`
- [ ] ระบบกลับสู่ quick action mode

## 5. Acknowledgement Flow

ใช้สำหรับทดสอบ flow `เรียก นยก / นกบ / นกพ / นกง`

- [ ] `BOSS` ส่ง `เรียก นยก`
- [ ] `NYK` ได้ Flex พร้อมปุ่ม `ทราบครับ`
- [ ] `NYK` ได้ Flex พร้อมปุ่ม `ขออภัยครับ ตอนนี้อยู่ด้านนอก`
- [ ] กด `ทราบครับ` แล้ว `BOSS` ได้ข้อความตอบกลับ
- [ ] กด `ขออภัยครับ ตอนนี้อยู่ด้านนอก` แล้ว `BOSS` ได้ข้อความตอบกลับ

## 6. File Upload

ใช้สำหรับทดสอบการรับไฟล์จาก LINE และเก็บไฟล์บน server

- [ ] อัปโหลดไฟล์จาก LINE ได้
- [ ] ระบบสร้าง record ใน `uploaded_files`
- [ ] ระบบบันทึกไฟล์ลง server ได้
- [ ] ปุ่ม `เปิดไฟล์` ใช้งานได้
- [ ] short link `/f/:id` ใช้งานได้

## 7. Staff Messaging

ใช้สำหรับทดสอบการส่งข้อความหรือส่งงานหาคนอื่น

- [ ] `ส่งข้อความให้กัน ...`
- [ ] `ส่งข้อความหาพี่นัย ...`
- [ ] `ส่งงานให้กัน ...`
- [ ] ระบบหาเป้าหมายถูกจากชื่อ / ชื่อเล่น / role
- [ ] ผู้รับได้ข้อความจริง
- [ ] ผู้ส่งได้ข้อความยืนยันว่า `ส่งแล้ว`

## 8. Secretary Review Flow

ใช้สำหรับทดสอบ flow ไฟล์จาก `NYK / NKB / NPK / NNG` ไปเลขา แล้วค่อยส่งต่อถึงผู้พัน

- [ ] `NYK` หรือ `NKB` หรือ `NPK` หรือ `NNG` ส่งไฟล์พร้อมคำสั่ง
- [ ] ไฟล์ไม่ส่งตรงถึง `BOSS`
- [ ] ไฟล์เข้า `SECRETARY` ก่อน
- [ ] `SECRETARY` เห็น Flex review พร้อมปุ่ม `อนุมัติ`
- [ ] `SECRETARY` เห็น Flex review พร้อมปุ่ม `ปฏิเสธ`
- [ ] กด `อนุมัติ` แล้ว `BOSS` ได้ไฟล์
- [ ] กด `อนุมัติ` แล้วผู้ส่งได้ข้อความยืนยัน
- [ ] กด `ปฏิเสธ` แล้วระบบขอเหตุผล
- [ ] เลขาพิมพ์เหตุผลแล้วผู้ส่งได้รับเหตุผลกลับ

## 9. Google Drive

ใช้สำหรับทดสอบ Google Drive integration หลังเปลี่ยน refresh token

- [ ] อัปโหลดไฟล์แล้ว `drive_sync_status = synced`
- [ ] มี `drive_file_id`
- [ ] มี `drive_url`
- [ ] ไฟล์ไปอยู่ในโฟลเดอร์ตาม role + file type ถูกต้อง

## 10. Known Pending

หัวข้อนี้ยังไม่ถือว่าต้องผ่านในรอบนี้ แต่ควรจำไว้ระหว่างทดสอบ

- [ ] Google Drive refresh token ยังไม่ได้เปลี่ยน
- [ ] QR code behavior ยังไม่ได้ทำ popup ตารางงานวันนี้
- [ ] alias management UI ยังไม่ได้ทำ
- [ ] role-aware response policy ยังไม่ได้ enforce ครบทุก role
