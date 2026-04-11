# Extension-Koyeb Architecture

## Goal
แยกส่วน `intent guard / command router / policy engine` ออกจาก `Koyeb1` เพื่อให้ใช้งานซ้ำได้กับ:
- ACDC LINE OA
- LINE OA ส่วนตัว
- bot/workflow อื่นในอนาคต

แนวคิดหลัก:
- `Koyeb1` เป็น `domain backend`
- `Extension-Koyeb` เป็น `shared command/policy layer`

## High-Level Split

### Koyeb1
รับผิดชอบสิ่งที่เป็น `ACDC business domain`

ตัวอย่าง:
- calendar events
- uploaded files
- file review workflow
- secretary approve/reject
- acknowledgement flow
- role assignment rules ของ ACDC
- Google Drive routing
- schedule cards / QR generation
- LINE channel integration ของ ACDC
- retrieved context จากข้อมูลจริงของ ACDC

### Extension-Koyeb
รับผิดชอบสิ่งที่เป็น `reusable conversational/control engine`

ตัวอย่าง:
- command registry
- role capability map
- menu/help generator
- confirm policy
- intent normalization
- ambiguity handling
- quick-action routing rules
- AI mode gate
- generic post-action confirmation templates

## Design Principle

### Keep In Koyeb1
เก็บสิ่งเหล่านี้ไว้ใน `Koyeb1`
- อะไรก็ตามที่ผูกกับ schema ของ ACDC โดยตรง
- workflow ที่อิง role เฉพาะของ ACDC
- integration กับ Supabase tables ของ ACDC
- integration กับ Google Drive folder layout ของ ACDC
- LINE messaging behavior ที่เป็น business flow ของ ACDC

### Move To Extension-Koyeb
ย้ายสิ่งเหล่านี้ไป `Extension-Koyeb`
- logic ที่ไม่ควรรู้จัก schema ภายในของ ACDC
- ตัวตัดสินว่าคำสั่งนี้ควรเข้า AI หรือ Quick Action
- ตัวแปลภาษาพูดเป็น command กลาง
- ตัวบอกว่า role ไหนมีสิทธิ์ใช้คำสั่งอะไร
- generic help/menu/permission rendering
- generic confirm-before-destructive pattern

## Recommended Layering

### Layer 1: Channel Adapter
รับข้อความจาก LINE OA แล้วแปลงเป็น request กลาง

ตัวอย่างข้อมูลเข้า:
- `channel`
- `lineUserId`
- `text`
- `messageType`
- `source metadata`

ฝั่ง ACDC ตอนนี้ adapter นี้ยังอยู่ใน `Koyeb1`

### Layer 2: Extension-Koyeb Core
เป็น shared engine

รับผิดชอบ:
- normalize input
- identify probable intent
- check role capabilities
- decide route:
  - quick action
  - AI mode
  - confirm required
  - deny
  - clarify
- generate help/menu text

ผลลัพธ์ที่ควรคืน:
- `resolvedAction`
- `normalizedCommand`
- `requiresConfirm`
- `denialMessage`
- `clarificationMessage`
- `uiHints`

### Layer 3: Domain Action Executor
อยู่ใน `Koyeb1`

รับผิดชอบ:
- ดึงข้อมูลจริงจาก DB
- สร้าง/ลบ/แก้ event
- ส่งข้อความให้ staff
- route file review
- generate card
- query uploaded file metadata
- build retrieved AI context จากข้อมูลจริง

### Layer 4: Delivery
อยู่ใน `Koyeb1`

รับผิดชอบ:
- reply text
- reply flex
- push message
- postback handling
- file delivery

## Responsibility Matrix

### Extension-Koyeb owns
- `/help`
- `/commands`
- `/menu`
- `/สิทธิ์`
- command aliasing เช่น:
  - `ตารางงานวันนี้`
  - `มีอะไรวันนี้`
  - `ขอสรุปงานเดือนนี้`
- role visibility rules
- destructive command confirmation policy
- AI vs Quick Action routing policy

### Koyeb1 owns
- `/event ...`
- `/summary ...`
- `/card today`
- `/files status`
- `/files clear-meta`
- `/files clear-all`
- `sendStaffMessage`
- `sendAcknowledgementRequest`
- `secretary review flow`
- `AI-on-file`
- `owner vs created_by`

## Contract Between Koyeb1 and Extension-Koyeb

แนะนำให้คุยกันผ่าน interface กลางแบบนี้

### Input
```ts
type CommandContext = {
  appId: string;
  channel: "line";
  actor: {
    userId: string;
    role: string;
    displayName?: string | null;
  };
  message: {
    type: "text" | "image" | "file" | "postback";
    text?: string;
    data?: string;
  };
};
```

### Output
```ts
type RouteDecision =
  | { type: "quick_action"; command: string }
  | { type: "ai_mode"; prompt: string }
  | { type: "denied"; message: string }
  | { type: "clarify"; message: string }
  | { type: "help"; message: string }
  | { type: "confirm"; actionKey: string; message: string };
```

แบบนี้ `Extension-Koyeb` ไม่ต้องรู้ schema ของ ACDC เลย

## Reuse Strategy

### For ACDC
ใช้ `Extension-Koyeb` พร้อม config ที่มี:
- role aliases ภาษาไทย
- command aliases ภาษาไทย
- confirm policy ของระบบงานทหาร
- AI access matrix ของ ACDC

### For Personal LINE OA
ใช้ `Extension-Koyeb` ชุดเดียวกันได้
แต่เปลี่ยน:
- role map
- command set
- workflow executor
- help/menu copy

## What Should Not Move Yet

สิ่งที่ยังไม่ควรรีบย้ายออกจาก `Koyeb1`
- LINE SDK integration ทั้งหมด
- DB access layer
- file storage logic
- Google Drive integration
- schedule summary generation
- secretary review workflow
- AI retrieved context builders

เหตุผล:
- ทั้งหมดนี้ยังผูกกับ domain และ infra ของ ACDC มาก
- ถ้าย้ายเร็วเกินไปจะทำให้ระบบสั่น

## First Extraction Candidates

ชิ้นที่ควรแยกเป็นก้อนแรก:

### 1. Role Capability Registry
เช่น:
- role ไหนใช้ AI ได้
- role ไหนส่งข้อความได้
- role ไหนเรียกกำลังพลได้
- role ไหนใช้ file purge ได้

### 2. Help/Menu Generator
เช่น:
- `/help`
- `/commands`
- `/menu`
- `/สิทธิ์`

### 3. Intent Normalizer
เช่น:
- `ตารางงานวันนี้`
- `มีอะไรวันนี้`
- `ขอสรุปงานสัปดาห์หน้า`
- `ฝากบอกเลขา...`

### 4. Confirm Policy
เช่น:
- ล้างไฟล์
- ส่งต่อไฟล์
- ลบกิจกรรม
- action ที่ควร confirm ก่อนเสมอ

## Suggested Repo Shape

### Option A: Separate Repo
`Extension-Koyeb`

เหมาะเมื่อ:
- จะใช้หลายโปรเจกต์จริง
- อยาก version/release แยก
- อยากให้ `Koyeb1` consume เป็น package/module

### Option B: Monorepo Package
อยู่ใต้ workspace เดียว เช่น:
- `packages/extension-koyeb`
- `apps/koyeb1-acdc-core`

เหมาะเมื่อ:
- ยัง iterate เร็ว
- อยาก refactor ไปพร้อมกัน
- ยังไม่อยากดูแลหลาย repo

## Recommended Path

ตอนนี้แนะนำ:

### Step 1
ให้ `Koyeb1` ใช้ต่อไปตามเดิม

### Step 2
แยกสิ่งนี้ออกก่อน:
- capability registry
- help/menu generator
- command normalization

### Step 3
ให้ `Koyeb1` เรียก `Extension-Koyeb` เพื่อได้ `RouteDecision`

### Step 4
เมื่อ stable แล้วค่อยย้าย confirm policy และ AI gate เพิ่ม

## Migration Rule

ใช้กฎนี้ตัดสินว่า logic ไหนควรย้าย:

### Move if
- ใช้ได้กับมากกว่า 1 LINE OA
- ไม่ต้อง query schema เฉพาะของ ACDC
- ไม่ต้องรู้ workflow ภายในของ ACDC

### Keep if
- ต้องใช้ตารางใน Supabase ของ ACDC
- ต้องรู้ role semantics เฉพาะของ ACDC
- ต้องแตะ file review / secretary flow / drive folder routing

## Practical Conclusion

### Best split
- `Extension-Koyeb` = command/policy engine
- `Koyeb1` = ACDC workflow/data backend

### Why this is the right split
- reuse OpenClaw กับ LINE OA อื่นได้
- ลด hardcode กระจัดกระจายใน `Koyeb1`
- เปลี่ยน policy/menu/help ได้ไวกว่า
- ไม่ไปเสี่ยงรื้อ domain logic ที่กำลังใช้งานได้อยู่

## Next Recommended Step

ถ้าจะลงมือต่อจากเอกสารนี้ ก้าวถัดไปที่เหมาะสุดคือ:

1. สร้าง `role capability registry` เป็นก้อนเดียว
2. ย้าย `/help`, `/commands`, `/menu`, `/สิทธิ์` ไปใช้ registry นี้
3. ค่อยแตก `intent normalization` เป็น module reusable
