# Koyeb1 Migration Matrix

This file maps the old ACDC implementation into the new `Koyeb1-ACDC-Core` service.

## Old Source Inventory

### `acdc_project/clawbot`

- `src/index.ts`
  Express app, LINE webhook, scheduler boot
- `src/services/line.service.ts`
  LINE event handling, file forwarding, Drive upload, async research mode
- `src/services/ai.service.ts`
  system prompt building, function-calling, provider routing
- `src/services/db.service.ts`
  data access helpers for users, events, prompts, logs
- `src/services/scheduler.service.ts`
  morning summary, evening summary, event alerts
- `src/services/drive.service.ts`
  Google Drive integration
- `src/scripts/generate_card.py`
  schedule card image generation

### `acdc_project/nextjs-calendar`

- `src/app/api/users`
  user admin APIs
- `src/app/api/events`
  event APIs
- `src/app/api/prompts`
  prompt and persona APIs
- `src/app/api/logs`
  conversation log APIs
- `src/lib/auth.ts`
  credentials auth flow
- UI components
  admin dashboard, prompt management, user management, calendar

## New Module Mapping

- `ai.service.ts`
  move prompt composition and tool decision logic into `src/modules/ai-gateway`
  remove direct provider calling and replace with `Koyeb0` client
- `db.service.ts`
  split into repository modules by domain:
  `users`, `calendar`, `prompts`, `logs`, `jobs`
- `line.service.ts`
  move into `src/modules/line`
- `scheduler.service.ts`
  move into `src/modules/scheduler`
  convert to persistent jobs and dedupe-safe alerts
- `nextjs-calendar` route handlers
  move into `src/modules/users`, `calendar`, `prompts`, `logs`

## Must Keep

- LINE RBAC behavior by role
- guest/user bootstrap flow
- staff message dispatch
- calendar create/delete/query workflows
- prompt and role persona config
- schedule card generation flow
- dashboard/admin compatibility
- conversation logging
- daily summaries and alerts

## Must Fix While Migrating

- scheduler timezone logic
- duplicate alert risk
- direct provider waterfall in business service
- mixed admin/API/backend concerns
- fragile in-memory file context only
- duplicated Prisma schema ownership between old services

## New Boundary Rule

- `Koyeb1` owns ACDC business logic
- `Koyeb0` owns AI provider routing
- `Supabase1` owns ACDC operational data
- frontend can stay on Next.js/Vercel, but should call `Koyeb1` and not duplicate backend rules
