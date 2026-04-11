# AI Retrieved Context Spec

อัปเดตล่าสุด: 2026-04-11

เอกสารนี้ใช้กำหนดสถาปัตย์ `AI with retrieved context` สำหรับ `Koyeb1 -> Koyeb0 -> Local LLM`

เป้าหมาย:

- ให้ AI ตอบบนข้อมูลจริงจากระบบ
- ลดการเดาหรือ hallucination เรื่องตาราง งาน ไฟล์ และ workflow
- ไม่ทำให้เครื่องหนักเกินจำเป็น
- ไม่ย้ายฐานข้อมูลทั้งหมดหรือไฟล์ทั้งหมดเข้า LLM

## 1. Principle

แนวทางหลักของระบบนี้คือ:

- `Supabase1` เป็น source of truth ของข้อมูลระบบ
- `Koyeb1` เป็นตัว query, filter, และประกอบ context
- `Koyeb0 / LLM` รับเฉพาะ context ก้อนเล็กที่จำเป็น
- `Local disk` ใช้เก็บไฟล์จริงและไฟล์ประกอบ ไม่ใช่ให้ AI อ่านทุกอย่างตรง ๆ

สรุปง่าย ๆ:

- `Quick Action = source of truth`
- `AI Mode = reasoning layer`
- `Retrieved Context = bridge ระหว่างระบบจริงกับ AI`

## 2. What We Should Not Do

ในรอบนี้ยังไม่ควรทำสิ่งต่อไปนี้:

1. ให้ AI query database ตรงทุกตาราง
2. ให้ AI อ่านไฟล์เต็มทุกครั้งที่ผู้ใช้ถาม
3. ทำ embedding ทั้งระบบทันที
4. ทำ vector database เต็มรูปแบบก่อนมี use case ชัด
5. ยัดข้อมูลจำนวนมากเข้า prompt ทุกครั้ง

เหตุผล:

- เปลืองทรัพยากรเครื่อง
- ช้า
- ซับซ้อนเกินจำเป็น
- ควบคุมความถูกต้องยาก

## 3. Storage Strategy

### 3.1 Supabase1

ใช้เก็บ:

- users
- roles
- aliases
- calendar_events
- uploaded_files
- review workflow metadata
- future file preview metadata

เหมาะสำหรับ:

- structured data
- filter/query ตามวัน ช่วงเวลา role และสถานะ

### 3.2 Local Disk on Koyeb1

ใช้เก็บ:

- ไฟล์จริงที่ผู้ใช้อัปโหลด
- ไฟล์ text/preview ที่สกัดได้ภายหลัง
- sidecar JSON ถ้าต้องเก็บ extraction result เพิ่ม

เหมาะสำหรับ:

- binary files
- large extracted text
- cached preprocessing artifacts

### 3.3 AI Context

ไม่ต้องเก็บระยะยาว

ใช้แบบ:

- query ตอน request
- สร้าง context ชั่วคราว
- ส่งเข้า AI
- จบแล้วทิ้ง

## 4. Retrieval Model

ทุกครั้งที่ AI จะตอบข้อมูลเชิงระบบ ให้ใช้ flow นี้

1. `Koyeb1` วิเคราะห์ intent
2. ถ้าเป็น quick action ล้วน ให้ quick action ตอบเลย
3. ถ้าต้องใช้ AI แต่ควรอิงข้อมูลจริง
   - `Koyeb1` query ข้อมูลเฉพาะส่วน
   - แปลงเป็น compact context
   - ส่งเข้า `Koyeb0`
4. `Koyeb0 / LLM` ตอบบน context ที่ได้รับเท่านั้น

## 5. Context Size Rule

หลักสำคัญคือ `small, relevant, recent`

แนวทาง:

- ตารางงาน: ส่งแค่รายการที่เกี่ยวข้อง 3-20 รายการ
- ไฟล์: ส่งแค่ metadata 1-5 รายการล่าสุด
- summary: ส่ง aggregate + top items
- file text: ส่ง preview สั้นก่อน เช่น 500-3000 ตัวอักษร

ห้าม:

- dump ตารางทั้งเดือนทั้งหมดทุกครั้ง
- dump ทั้งไฟล์ PDF ยาวหลายสิบหน้าใน prompt เดียว
- dump uploaded_files ทั้งระบบ

## 6. Retrieval Types

### 6.1 Calendar Retrieval

เหมาะกับคำถาม:

- วันนี้มีงานอะไร
- สรุปงานสัปดาห์นี้แบบผู้บริหาร
- งานวันอังคารหน้าเป็นอย่างไร

ข้อมูลที่ควรส่งให้ AI:

- date range
- event count
- selected events
- title
- time
- location
- location type
- note/description snippet

ตัวอย่าง context shape:

```json
{
  "source": "calendar_events",
  "range_label": "วันนี้",
  "total": 3,
  "events": [
    {
      "date": "2026-04-11",
      "start": "08:00",
      "end": "17:00",
      "title": "ทำงาน",
      "location_type": "INTERNAL",
      "location_display_name": "กองบังคับการ"
    }
  ]
}
```

### 6.2 File Registry Retrieval

เหมาะกับคำถาม:

- ไฟล์ล่าสุดคืออะไร
- มีไฟล์ที่เลขาส่งเข้ามาหรือยัง
- เอกสารนี้อยู่ขั้นตอนไหน

ข้อมูลที่ควรส่ง:

- file name
- mime type
- uploaded by
- created_at
- review_status
- drive_sync_status
- local_disk_url หรือ short link

ห้ามส่ง:

- binary file ตรง ๆ เข้า AI

### 6.3 Workflow Retrieval

เหมาะกับคำถาม:

- ไฟล์นี้รอเลขาอนุมัติหรือยัง
- ส่งถึงผู้พันหรือยัง
- ใครเป็นผู้รับ review

ข้อมูลที่ควรส่ง:

- review_status
- review_requested_to_user_id
- review_target_user_id
- review_message
- review_reason
- timestamps สำคัญ

## 7. AI-on-File Strategy

AI-on-file ควรทำแบบ `preview-first`

### Phase A: Metadata Only

เก็บและใช้:

- file_name
- mime_type
- size_bytes
- created_at
- uploader
- review status

เหมาะสำหรับ:

- ค้นว่าไฟล์ไหนล่าสุด
- ตอบคำถามสถานะไฟล์

### Phase B: Extracted Preview

หลัง upload หรือ background step ค่อยสกัด:

- `preview_text`
- `page_count`
- `summary_short`

เหมาะสำหรับ:

- สรุปไฟล์สั้น ๆ
- ตอบคำถามเบื้องต้น

### Phase C: Deep Read on Demand

ถ้าผู้ใช้ขอเจาะลึกจริง:

- อ่านเฉพาะบางหน้า
- อ่านเฉพาะ section ที่เกี่ยวข้อง
- หรือ chunk เฉพาะส่วน

ไม่ควร:

- อ่านทั้งไฟล์ยาวทุกครั้งโดย default

## 8. Suggested Storage for File Preview

มี 2 แนวทางที่เหมาะ

### Option 1: Store Small Preview in Supabase1

เพิ่ม field เช่น:

- `preview_text`
- `summary_short`
- `page_count`

เหมาะเมื่อ:

- text ไม่ยาวมาก
- อยาก query ง่าย

### Option 2: Store Sidecar Files on Disk

เก็บไฟล์ประกอบ เช่น:

- `/app/storage/uploads/.../file.preview.txt`
- `/app/storage/uploads/.../file.meta.json`

แล้วใน DB เก็บ path:

- `preview_path`
- `meta_path`

เหมาะเมื่อ:

- preview ยาว
- มี extraction หลายแบบ
- ไม่อยากให้ DB โตเร็ว

ข้อเสนอรอบแรก:

- เริ่มจาก `Supabase1` สำหรับ `summary_short`, `page_count`
- ถ้า preview ใหญ่ขึ้นค่อยแยกลง disk

## 9. Suggested New Fields

ถ้าจะเริ่ม AI-on-file แบบเบา แนะนำ field เพิ่มใน `uploaded_files`

- `page_count integer`
- `preview_text text`
- `summary_short text`
- `extraction_status text default 'pending'`
- `extraction_error text`
- `preview_path text`

หมายเหตุ:

- ไม่จำเป็นต้องเพิ่มทั้งหมดทีเดียว
- เริ่มจาก `summary_short`, `page_count`, `extraction_status` ก่อนก็ได้

## 10. Retrieval Guardrails

ก่อนส่ง context เข้า AI ต้องมี guardrail นี้

1. ถ้า query ไม่ได้ข้อมูลจริง ให้บอกว่า `no verified data`
2. ถ้าไฟล์ยังไม่ถูก extract ห้าม AI เดาเนื้อหาไฟล์
3. ถ้า context มาจากช่วงเวลาใด ต้องแนบ label ช่วงเวลาไปด้วยเสมอ
4. ถ้าข้อมูลไม่ครบ ต้องให้ AI ระบุว่าคำตอบนี้อิงเท่าที่มี

## 11. Suggested Runtime Flow

### 11.1 For Schedule Summary with AI Style

1. User: `AI ช่วยสรุปงานวันนี้แบบผู้บริหาร`
2. `Koyeb1` เห็นว่าเป็น schedule intent
3. `Koyeb1` query events วันนี้
4. `Koyeb1` สร้าง retrieved context
5. `Koyeb1` ส่ง prompt + context + role prompt ไป `Koyeb0`
6. `Koyeb0` สรุปในโทน `BOSS`

### 11.2 For File Summary

1. User: `AI ช่วยสรุปไฟล์ล่าสุด`
2. `Koyeb1` query latest uploaded file metadata
3. ถ้ามี `summary_short` ใช้อันนั้นก่อน
4. ถ้าไม่มี ให้ตอบว่ายังไม่มี extracted summary
5. ภายหลังค่อยเพิ่ม extraction worker

## 12. Performance Policy

เพื่อลดภาระเครื่อง:

1. Query เฉพาะข้อมูลที่เกี่ยวข้อง
2. Limit record count ทุกครั้ง
3. อย่าส่ง text เกินจำเป็นเข้า LLM
4. Cache summary ที่ใช้บ่อยเมื่อเหมาะสม
5. Extraction file ให้ทำ background ได้ในอนาคต

## 13. Recommended Phasing

### Phase 1

- ทำ `AI with retrieved schedule context`
- ใช้กับ summary งานเท่านั้น

### Phase 2

- ทำ `AI with file metadata context`
- ยังไม่อ่านเนื้อไฟล์เต็ม

### Phase 3

- เพิ่ม `summary_short / preview_text`
- เริ่ม AI-on-file แบบเบา

### Phase 4

- ถ้ามี use case จริงค่อยเพิ่ม deep read/chunking

## 14. What To Build Next

ถ้าจะลงมือจริง ลำดับที่เหมาะที่สุดคือ:

1. สร้าง helper สำหรับ `buildRetrievedCalendarContext(...)`
2. เพิ่ม route/flow สำหรับ `AI summary on verified schedule data`
3. ออกแบบ schema เพิ่มของ `uploaded_files` สำหรับ extraction เบื้องต้น
4. ค่อยต่อ `AI-on-file`

## 15. Success Criteria

ถือว่าสำเร็จเมื่อ:

- AI สรุปงานบนข้อมูลจริงจากระบบได้
- AI ไม่แต่งข้อมูลตารางเมื่อ query ไม่เจอ
- ระบบไม่ส่ง context ใหญ่เกินจำเป็น
- เครื่องไม่ต้องแบก vector db หรือ file parsing หนักเกินในรอบแรก
