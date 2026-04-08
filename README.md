# Koyeb1 ACDC Core

`Koyeb1-ACDC-Core` is the main ACDC business backend in the new Cloud Swarm architecture.

It replaces the mixed responsibilities currently spread across:

- `acdc_project/clawbot`
- `acdc_project/nextjs-calendar`

and keeps the business logic in one backend service while delegating AI provider routing to `Koyeb0`.

## Role In The New System

- own the ACDC business logic
- receive LINE webhook traffic
- manage users, roles, and permissions
- manage calendar events and operational schedules
- manage prompts, personas, and ACDC behavior config
- record conversation and activity logs
- trigger reminders and notifications
- call `Koyeb0` whenever AI is needed

## Current Scope

Implemented now:

- auth login
- users API
- calendar events API
- prompts/personas API
- conversation logs API
- LINE webhook handling
- guest/user bootstrap from LINE user ID
- `Koyeb0` chat integration
- async research path for `BOSS` and `ADMIN`
- scheduler jobs for summaries and alerts
- Google Drive file/image upload path
- staff message forwarding
- schedule card image generation
- static `/images/...` serving for generated cards

Still to expand later:

- richer natural-language calendar parsing
- full old-system parity for file workflows
- more advanced tool/action orchestration

## Old System -> New System

### Old ACDC Shape

- `clawbot`
  LINE webhook, file handling, AI orchestration, scheduling, card generation
- `nextjs-calendar`
  admin login, users, events, logs, prompts, dashboard API
- shared database with Prisma models for users, events, prompts, and logs

### New Koyeb1 Shape

- `api`
  REST endpoints for admin/dashboard integration
- `line`
  LINE webhook handling and outbound messaging
- `calendar`
  event CRUD, scheduling rules, summaries, reminders
- `staff`
  staff lookup and message-to-staff workflows
- `prompts`
  bot config and role persona management
- `logs`
  conversations, webhook activity, job runs, audit logs
- `scheduler`
  reminder and digest execution
- `ai-client`
  internal client for `Koyeb0`
- `drive`
  Google Drive upload integration
- `cards`
  image card generation

## Suggested Deployment Layout

- `Koyeb1`
  ACDC backend service
- `Supabase1`
  ACDC data store
- `Koyeb0`
  AI gateway for all AI requests
- `Vercel`
  Next.js admin frontend if you keep it separate

## Do I Need Vercel For Koyeb1?

No. `Koyeb1` itself does not need Vercel.

Use this split:

- `Koyeb1` on Koyeb
  backend API, LINE webhook, jobs, business logic
- `Supabase1` on Supabase
  database and operational data
- `Vercel` only if you want a separate Next.js frontend or admin dashboard

That means:

- if you are only deploying the backend service, deploy `Koyeb1` on Koyeb only
- do not deploy `Koyeb1` to Vercel
- use Vercel only for a web UI such as an admin panel

## API Surface

- `GET /`
- `GET /health`
- `POST /webhooks/line`
- `POST /api/auth/login`
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id`
- `GET /api/events`
- `POST /api/events`
- `PATCH /api/events/:id`
- `DELETE /api/events/:id`
- `GET /api/prompts`
- `PUT /api/prompts`
- `GET /api/logs`
- `POST /api/jobs/run`

## Supabase1 Setup

Run the SQL file below in the Supabase SQL Editor before first deployment:

- `supabase/SQLEditor.sql`

This creates:

- `users`
- `calendar_events`
- `bot_config`
- `role_personas`
- `conversation_logs`
- `staff_messages`
- `generated_cards`
- `uploaded_files`
- `scheduler_jobs`
- `event_alert_logs`
- `webhook_logs`

## Environment Variables

Use [.env.example](C:/Users/zexqm/programing/MutiInformation/Koyeb1-ACDC-Core/.env.example) as the base.

### Core

- `PORT`
- `NODE_ENV`
- `APP_TIMEZONE`
- `INTERNAL_API_KEY`
- `JWT_SECRET`
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### LINE

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

### AI Gateway

- `KOYEB0_BASE_URL`
- `KOYEB0_INTERNAL_API_KEY`
- `KOYEB0_DEFAULT_POLICY`

### Public URLs

- `PUBLIC_BASE_URL`
- `NEXTJS_FRONTEND_URL`
- `DASHBOARD_CARD_URL`

### Google Drive

Required minimum:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_ROOT_FOLDER`

Optional generic folders:

- `GOOGLE_DRIVE_IMAGE_FOLDER`
- `GOOGLE_DRIVE_FILE_FOLDER`

Optional role-aware folders:

- `GOOGLE_DRIVE_BOSS_ROOT_FOLDER`
- `GOOGLE_DRIVE_SECRETARY_ROOT_FOLDER`
- `GOOGLE_DRIVE_ADMIN_ROOT_FOLDER`
- `GOOGLE_DRIVE_USER_ROOT_FOLDER`
- `GOOGLE_DRIVE_GUEST_ROOT_FOLDER`
- `GOOGLE_DRIVE_BOSS_IMAGE_FOLDER`
- `GOOGLE_DRIVE_SECRETARY_IMAGE_FOLDER`
- `GOOGLE_DRIVE_ADMIN_IMAGE_FOLDER`
- `GOOGLE_DRIVE_USER_IMAGE_FOLDER`
- `GOOGLE_DRIVE_GUEST_IMAGE_FOLDER`
- `GOOGLE_DRIVE_BOSS_FILE_FOLDER`
- `GOOGLE_DRIVE_SECRETARY_FILE_FOLDER`
- `GOOGLE_DRIVE_ADMIN_FILE_FOLDER`
- `GOOGLE_DRIVE_USER_FILE_FOLDER`
- `GOOGLE_DRIVE_GUEST_FILE_FOLDER`

### Jobs

- `MORNING_SUMMARY_CRON`
- `EVENING_SUMMARY_CRON`
- `EVENT_ALERT_CRON`

## Local Development

1. Copy `.env.example` to `.env`
2. Install dependencies:

```bash
npm install
```

3. Run type check:

```bash
npm run check
```

4. Run build:

```bash
npm run build
```

5. Start local dev server:

```bash
npm run dev
```

## Docker And Runtime Notes

The Docker image now includes:

- Node.js runtime
- Python 3
- Pillow
- qrcode

This is required because schedule cards are generated by:

- `src/scripts/generate_card.py`

Important:

- generated images are served from `/images/...`
- `PUBLIC_BASE_URL` must point to the public `Koyeb1` URL so LINE can load the generated image
- if `PUBLIC_BASE_URL` is missing, schedule-card sending will fail

## Deploy To Railway

Recommended path:

1. push this repo to GitHub
2. create a new Railway project from GitHub
3. choose Dockerfile deployment
4. set the service port to `8001`
5. add all required env vars
6. deploy
7. copy the public Railway URL

### Simple Answer

For `Koyeb1`, you only need:

1. GitHub repo
2. Railway service
3. Supabase project
4. LINE webhook configuration

You do not need Vercel unless you also want a separate frontend.

### What To Create

- Railway Project:
  `koyeb1-acdc-core`
- Railway Service Type:
  Dockerfile service
- Supabase Project:
  your chosen real project for logical `Supabase1`
- LINE Webhook:
  points to `https://your-railway-service.up.railway.app/webhooks/line`

### Setup Order

1. create or choose `Supabase1`
2. run `supabase/SQLEditor.sql`
3. create Railway project from this GitHub repo
4. set all environment variables in Railway
5. deploy the Railway service
6. copy the public Railway URL
7. configure LINE webhook URL
8. test `/health`
9. test LINE messaging

### If You Also Want A Frontend

Only in that case:

- deploy frontend on Vercel
- keep backend on Koyeb
- let the frontend call `Koyeb1`

Recommended split:

- `Koyeb1` = backend only
- `Vercel` = frontend only

Minimum production env recommendation:

```env
PORT=8001
NODE_ENV=production
APP_TIMEZONE=Asia/Bangkok
INTERNAL_API_KEY=change-this
JWT_SECRET=replace-with-a-long-secret
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=replace-me
LINE_CHANNEL_ACCESS_TOKEN=replace-me
LINE_CHANNEL_SECRET=replace-me
KOYEB0_BASE_URL=https://your-koyeb0-service.koyeb.app
KOYEB0_INTERNAL_API_KEY=change-this
KOYEB0_DEFAULT_POLICY=private_first
PUBLIC_BASE_URL=https://your-koyeb1-service.koyeb.app
NEXTJS_FRONTEND_URL=https://your-frontend.vercel.app
DASHBOARD_CARD_URL=https://your-frontend.vercel.app
GOOGLE_DRIVE_CLIENT_ID=replace-me
GOOGLE_DRIVE_CLIENT_SECRET=replace-me
GOOGLE_DRIVE_REFRESH_TOKEN=replace-me
GOOGLE_DRIVE_ROOT_FOLDER=replace-me
MORNING_SUMMARY_CRON=0 7 * * *
EVENING_SUMMARY_CRON=0 18 * * *
EVENT_ALERT_CRON=*/5 * * * *
```

For Railway, change:

```env
PUBLIC_BASE_URL=https://your-railway-service.up.railway.app
```

## LINE Webhook Setup

After deployment:

1. copy the public Koyeb URL
2. set LINE webhook URL to:

```text
https://your-railway-service.up.railway.app/webhooks/line
```

3. enable webhook delivery in LINE Developers Console
4. verify signature handling with a test event

## Supported LINE Commands

Explicit commands:

- `/event today`
- `/card today`
- `/event add | title | startISO | endISO | locationType | locationName`
- `/event delete | keyword`
- `/staff send | target | message`
- `ส่งไฟล์นี้ให้ [ชื่อ] [ข้อความ]`

Supported natural-language shortcuts:

- `ตารางวันนี้`
- `ดูตารางวันนี้`
- `สรุปงานวันนี้`
- `ขอการ์ดวันนี้`
- `ขอการ์ดตารางวันนี้`
- `ขอสรุปงานแบบรูป`
- `ส่งข้อความให้ [ชื่อ] ว่า [ข้อความ]`
- `ลบกิจกรรม [คำค้น]`
- `เพิ่มกิจกรรม [ชื่อ] เริ่ม [เวลา] จบ [เวลา] สถานที่ [ชื่อ]`

Note:

- natural-language support is still simple pattern matching
- for reliability, slash-style commands remain the safest path right now

## Verification Checklist

- [ ] run `supabase/SQLEditor.sql` in `Supabase1`
- [ ] create at least one `ADMIN` user in `users`
- [ ] set all Koyeb env vars
- [ ] verify `Koyeb1` can reach `Koyeb0`
- [ ] verify LINE webhook is accepted
- [ ] verify a `GUEST` LINE user gets the correct warning message
- [ ] verify an allowed user gets an AI response from `Koyeb0`
- [ ] verify `/event today`
- [ ] verify `/event add ...`
- [ ] verify `/staff send ...`
- [ ] verify image/file upload to Google Drive
- [ ] verify `/card today`
- [ ] verify generated card image is publicly reachable from `PUBLIC_BASE_URL`

## Current Status

- scaffold created
- Phase 1 backend implemented
- Phase 2 LINE + scheduler foundation implemented
- Phase 2.5 file/staff/card workflow implemented
- compile clean:
  - `npm run check`
  - `npm run build`

## Next Recommended Work

- add richer Thai natural-language parsing for calendar actions
- add more complete old-system file workflow parity
- create a real deploy pass on Railway with `Supabase1` and LINE webhook verification

## Deployment Plan (TH)

### ถ้า Koyeb ของคุณยังไม่มีแผนฟรี

- ให้ถือว่า `Koyeb1` พร้อมในระดับ code แล้ว
- ยังไม่ต้องย้ายไป Vercel เพราะ repo นี้เป็น backend
- ให้เก็บ env, LINE secret, และ Google Drive secret ให้ครบก่อน

### Koyeb1 เราจะใช้ทำอะไร

- เป็น backend หลักของ ACDC
- รับ `LINE webhook`
- จัดการ `users`, `events`, `prompts`, `logs`
- เรียก AI ผ่าน `Koyeb0`
- จัดการ scheduler, file upload, และ schedule card

### วิธี deploy Koyeb1

1. เปิด Railway แล้วสร้าง `Project`
2. เลือก deploy จาก GitHub
3. เลือก repo `Koyeb1-ACDC-Core`
4. เลือก branch `main`
5. เลือก build แบบ `Dockerfile`
6. ตั้ง `Port` เป็น `8001`
7. ใส่ environment variables หลัก:
- `PORT=8001`
- `NODE_ENV=production`
- `APP_TIMEZONE=Asia/Bangkok`
- `INTERNAL_API_KEY=...`
- `JWT_SECRET=...`
- `SUPABASE_URL=...`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `KOYEB0_BASE_URL=...`
- `KOYEB0_INTERNAL_API_KEY=...`
- `KOYEB0_DEFAULT_POLICY=private_first`
- `PUBLIC_BASE_URL=https://your-railway-service.up.railway.app`
8. ถ้าจะใช้ LINE ให้เพิ่ม:
- `LINE_CHANNEL_ACCESS_TOKEN=...`
- `LINE_CHANNEL_SECRET=...`
9. ถ้าจะใช้ Google Drive ให้เพิ่ม:
- `GOOGLE_DRIVE_CLIENT_ID=...`
- `GOOGLE_DRIVE_CLIENT_SECRET=...`
- `GOOGLE_DRIVE_REFRESH_TOKEN=...`
- `GOOGLE_DRIVE_ROOT_FOLDER=...`
10. กด deploy
11. หลัง deploy ให้ทดสอบ:
- `GET /health`
- `POST /api/auth/login`
- `POST /webhooks/line`
- การเชื่อมต่อไป `Koyeb0`

### สิ่งที่ต้องสำเร็จหลัง deploy

- service รันได้
- ต่อ `Supabase1` ได้
- เรียก `Koyeb0` ได้
- พร้อมเชื่อม LINE webhook
- พร้อมใช้เป็น backend หลักของ ACDC
