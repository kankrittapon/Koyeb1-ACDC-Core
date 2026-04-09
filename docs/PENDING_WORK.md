# Koyeb1 Pending Work

อัปเดตล่าสุด: 2026-04-10

## Done

- `Koyeb0` live และ `Koyeb1` live บน `100.68.88.63`
- LINE webhook ใช้งานได้ผ่าน `https://acdc-api.kankrittapon.online/webhooks/line`
- frontend ใช้งานได้ที่ `https://acdc-operations-frontend.vercel.app`
- quick actions หลักของปฏิทินเริ่มใช้งานได้
- card renderer เปลี่ยนเป็น `HTML/CSS -> image` แล้ว
- file upload ลง local storage ได้
- file registry ใน `uploaded_files` ใช้งานได้
- `ส่งไฟล์นี้ให้...` และ `ส่งข้อความให้...` ใช้งานได้
- short link สำหรับไฟล์มีแล้วใน route `/f/:id`

## Pending Now

### 1. Google Drive Refresh Token

สถานะ:
- Google Drive ยังไม่บันทึกไฟล์สำเร็จ

อาการ:
- `uploaded_files.drive_sync_status = failed`
- error ล่าสุดคือ `invalid_grant`

สิ่งที่ต้องทำ:
- ออก `GOOGLE_DRIVE_REFRESH_TOKEN` ใหม่
- ใส่ค่าใหม่ใน `Koyeb1` live env
- ทดสอบ upload ซ้ำให้ `drive_file_id` และ `drive_url` ถูกเขียน

### 2. Local Upload Persistence

สถานะ:
- ตอนนี้ไฟล์ถูกเก็บใน filesystem ของ container

ความเสี่ยง:
- ถ้า rebuild/recreate container ไฟล์ local copy อาจหาย

สิ่งที่ต้องทำ:
- เพิ่ม host volume mount สำหรับ `storage/uploads`
- ให้ local disk copy เป็น persistent จริงบน server

### 3. User Aliases Management

สถานะ:
- table `user_aliases` มีแล้ว
- logic lookup alias มีแล้ว

สิ่งที่ยังไม่มี:
- หน้า frontend สำหรับเพิ่ม/ลบ alias
- quick command สำหรับจัดการ alias

ตัวอย่างเป้าหมาย:
- `กัน`
- `พี่กัน`
- `นัย`
- `พี่นัย`

### 4. File Delivery UX

สถานะ:
- ผู้รับไฟล์จะได้ Flex card พร้อมปุ่มเปิดไฟล์

สิ่งที่ควรทำต่อ:
- ปรับหน้าตา Flex ให้สวยขึ้น
- เพิ่มปุ่ม `Google Drive` เมื่อ Drive ใช้งานได้แล้ว
- เพิ่มข้อความยืนยันฝั่งผู้ส่งให้อ่านสั้นและชัดขึ้นอีก

### 5. AI-on-File

สถานะ:
- ยังไม่ได้ทำ extraction/summary ของไฟล์

แนวทางที่ตกลงกัน:
- ไม่ให้ AI อ่านทั้งไฟล์ยาวตรงๆ ทุกครั้ง
- ทำแบบ preview-first

สิ่งที่ต้องทำ:
- extract text/preview ตอน upload
- เก็บ cached summary ลงฐาน
- ให้ AI mode ใช้ preview/summary ก่อน

### 6. QR Code Behavior

สถานะ:
- card ใช้งานได้แล้ว
- QR ยังไม่ได้ finalize behavior

แนวทางที่คุยไว้:
- เมื่อสแกนแล้วควรเปิดตารางงานวันนี้
- อาจเป็น popup หรือ route เฉพาะใน frontend

### 7. Role-aware Response

สถานะ:
- ยังพักไว้ก่อนตามที่คุยกัน

สิ่งที่ต้องทำภายหลัง:
- แยก behavior ของ `BOSS`, `SECRETARY`, `ADMIN`, `USER`
- แยกสิทธิ์และรูปแบบข้อความให้ชัดขึ้น

### 8. Quick Action Coverage

สถานะ:
- ดีขึ้นมากแล้ว แต่ยังควรเก็บเคสภาษาพูดเพิ่มเรื่อยๆ

สิ่งที่ต้องไล่ต่อจาก usage จริง:
- ภาษาพิมพ์ติดกัน
- คำสั้นแบบกำกวม
- คำสั่งหลายรูปแบบในประโยคเดียว

## Suggested Next Order

1. แก้ `GOOGLE_DRIVE_REFRESH_TOKEN`
2. ทำ persistent volume สำหรับ `storage/uploads`
3. เพิ่ม alias management
4. ทำ AI-on-file แบบ preview-first
5. ค่อยกลับไป finalize QR behavior
