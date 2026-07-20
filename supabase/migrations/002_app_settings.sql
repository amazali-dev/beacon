-- Beacon app settings + job queue (controlled from the dashboard)
-- Run this in Supabase SQL Editor after 001_initial.sql

-- Key/value settings (schedule, thresholds — edited in the browser)
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- On-demand jobs from the dashboard ("Run now" buttons)
create table if not exists public.check_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('load_check', 'form_test', 'detect_forms', 'daily_report')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  notes text
);

create index if not exists check_jobs_pending_idx
  on public.check_jobs (requested_at)
  where status = 'pending';

alter table public.app_settings enable row level security;
alter table public.check_jobs enable row level security;

create policy "Authenticated read app_settings"
  on public.app_settings for select to authenticated using (true);
create policy "Authenticated update app_settings"
  on public.app_settings for update to authenticated using (true) with check (true);
create policy "Authenticated insert app_settings"
  on public.app_settings for insert to authenticated with check (true);

create policy "Authenticated read check_jobs"
  on public.check_jobs for select to authenticated using (true);
create policy "Authenticated insert check_jobs"
  on public.check_jobs for insert to authenticated with check (true);

-- Default schedule (matches engine/config/defaults.json)
insert into public.app_settings (key, value) values
  ('loadCheckIntervalMinutes', '30'),
  ('formTestTimesEastern', '["00:00","06:00","12:00","18:00"]'),
  ('dailyReportTimeEastern', '"23:30"'),
  ('loadTimeThresholdMs', '8000'),
  ('alertCooldownHours', '2'),
  ('formLayer1TimeoutSeconds', '15'),
  ('formLayer2TimeoutMinutes', '10'),
  ('skipAlertsInStaging', 'true'),
  ('stagingLabel', '"Pakistan staging"'),
  ('engine_heartbeat', 'null'),
  ('engine_mode', '"staging"')
on conflict (key) do nothing;
