create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text unique,
  password_hash text,
  role text not null default 'GUEST',
  line_user_id text unique,
  line_display_name text,
  picture_url text,
  nickname text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  dress_code text,
  note text,
  task_details text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  is_all_day boolean not null default false,
  location_type text not null default 'INTERNAL',
  location_display_name text,
  owner_user_id uuid references public.users(id) on delete set null,
  created_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_events add column if not exists dress_code text;
alter table public.calendar_events add column if not exists note text;
alter table public.calendar_events add column if not exists task_details text;

create index if not exists idx_calendar_events_start_at on public.calendar_events(start_at);
create index if not exists idx_calendar_events_owner_user_id on public.calendar_events(owner_user_id);

create table if not exists public.bot_config (
  id text primary key default 'default',
  ai_mode text not null default 'gateway',
  is_active boolean not null default true,
  system_instruction text not null default 'คุณคือระบบ ACDC Core Assistant',
  updated_at timestamptz not null default now()
);

create table if not exists public.role_personas (
  id uuid primary key default gen_random_uuid(),
  role text not null unique,
  greeting text not null default '',
  tone text not null default '',
  behavior text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  line_user_id text,
  message text not null,
  bot_response text,
  source text not null default 'line',
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_logs_line_user_id on public.conversation_logs(line_user_id);
create index if not exists idx_conversation_logs_created_at on public.conversation_logs(created_at desc);

create table if not exists public.staff_messages (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid references public.users(id) on delete set null,
  target_user_id uuid references public.users(id) on delete set null,
  target_line_user_id text,
  message text not null,
  file_url text,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.generated_cards (
  id uuid primary key default gen_random_uuid(),
  requested_by_user_id uuid references public.users(id) on delete set null,
  target_date date not null,
  image_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.uploaded_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  line_user_id text,
  file_name text not null,
  mime_type text,
  source_provider text not null default 'line',
  line_message_id text,
  original_file_name text,
  stored_file_name text,
  size_bytes bigint,
  local_disk_path text,
  local_disk_url text,
  drive_file_id text,
  drive_url text,
  review_status text not null default 'none',
  review_requested_to_user_id uuid references public.users(id) on delete set null,
  review_target_user_id uuid references public.users(id) on delete set null,
  review_message text,
  review_reason text,
  drive_sync_status text not null default 'pending',
  drive_sync_error text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.uploaded_files add column if not exists source_provider text not null default 'line';
alter table public.uploaded_files add column if not exists line_message_id text;
alter table public.uploaded_files add column if not exists original_file_name text;
alter table public.uploaded_files add column if not exists stored_file_name text;
alter table public.uploaded_files add column if not exists size_bytes bigint;
alter table public.uploaded_files add column if not exists local_disk_path text;
alter table public.uploaded_files add column if not exists local_disk_url text;
alter table public.uploaded_files add column if not exists drive_sync_status text not null default 'pending';
alter table public.uploaded_files add column if not exists drive_sync_error text;
alter table public.uploaded_files add column if not exists review_status text not null default 'none';
alter table public.uploaded_files add column if not exists review_requested_to_user_id uuid references public.users(id) on delete set null;
alter table public.uploaded_files add column if not exists review_target_user_id uuid references public.users(id) on delete set null;
alter table public.uploaded_files add column if not exists review_message text;
alter table public.uploaded_files add column if not exists review_reason text;
alter table public.uploaded_files add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_uploaded_files_line_user_id on public.uploaded_files(line_user_id);
create index if not exists idx_uploaded_files_created_at on public.uploaded_files(created_at desc);

create table if not exists public.user_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  unique (user_id, alias)
);

create index if not exists idx_user_aliases_alias on public.user_aliases(alias);

create table if not exists public.scheduler_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  job_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  run_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_scheduler_jobs_status_run_at on public.scheduler_jobs(status, run_at);

create table if not exists public.event_alert_logs (
  id uuid primary key default gen_random_uuid(),
  calendar_event_id uuid not null references public.calendar_events(id) on delete cascade,
  alert_type text not null,
  alert_key text not null unique,
  sent_to_line_user_id text,
  sent_at timestamptz not null default now()
);

create table if not exists public.webhook_logs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'line',
  event_type text not null,
  line_user_id text,
  request_id text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'received',
  created_at timestamptz not null default now()
);

insert into public.bot_config (id, ai_mode, is_active, system_instruction)
values ('default', 'gateway', true, 'คุณคือระบบ ACDC Core Assistant')
on conflict (id) do nothing;

insert into public.role_personas (role, greeting, tone, behavior)
values
  ('BOSS', 'สวัสดีครับท่านบอส', 'สุภาพ กระชับ และพร้อมรายงาน', 'สรุปสั้น ชัด ตรงประเด็น'),
  ('SECRETARY', 'สวัสดีครับ', 'มืออาชีพ และช่วยประสานงาน', 'ช่วยจัดตารางและติดตามงาน'),
  ('NYK', 'สวัสดีครับ', 'สุภาพและรับคำสั่งอย่างเป็นทางการ', 'ใช้ quick action เป็นหลัก และตอบรับคำสั่งอย่างชัดเจน'),
  ('NKB', 'สวัสดีครับ', 'สุภาพและรับคำสั่งอย่างเป็นทางการ', 'ใช้ quick action เป็นหลัก และตอบรับคำสั่งอย่างชัดเจน'),
  ('NPK', 'สวัสดีครับ', 'สุภาพและรับคำสั่งอย่างเป็นทางการ', 'ใช้ quick action เป็นหลัก และตอบรับคำสั่งอย่างชัดเจน'),
  ('NNG', 'สวัสดีครับ', 'สุภาพและรับคำสั่งอย่างเป็นทางการ', 'ใช้ quick action เป็นหลัก และตอบรับคำสั่งอย่างชัดเจน'),
  ('ADMIN', 'สวัสดีครับแอดมิน', 'ตรงไปตรงมาแต่สุภาพ', 'เน้นงานระบบและการจัดการ'),
  ('USER', 'สวัสดีครับ', 'สุภาพและเป็นมิตร', 'ให้ความช่วยเหลือทั่วไป'),
  ('GUEST', 'สวัสดีครับ', 'สุภาพและชี้แจงสิทธิ์การใช้งาน', 'แนะนำให้ติดต่อแอดมินเพื่อเปิดสิทธิ์')
on conflict (role) do nothing;
