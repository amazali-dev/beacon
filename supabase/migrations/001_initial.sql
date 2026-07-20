-- Website Monitoring System — initial database setup
-- Paste this entire file into the Supabase SQL Editor and click Run.

-- ============================================================
-- TABLES
-- ============================================================

-- Sites to monitor (managed from the dashboard Settings page)
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  main_url text not null,
  extra_urls jsonb not null default '[]'::jsonb,
  quote_form_url text,
  form_testing_enabled boolean not null default true,
  -- Key page elements: logo, headline, cta, quote_form
  selectors jsonb not null default '{}'::jsonb,
  -- Form field selectors: name, email, phone, message, file, submit
  form_selectors jsonb not null default '{}'::jsonb,
  -- Result of last auto-detection pass (plain-English status for the dashboard)
  form_detection_status jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Module 1: load / render checks (one row per site × device profile)
create table if not exists public.load_checks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  profile text not null check (profile in ('desktop', 'webkit', 'mobile')),
  checked_at timestamptz not null default now(),
  status_code integer,
  loaded boolean not null default false,
  load_ms integer,
  lcp_ms integer,
  cls numeric,
  console_errors jsonb not null default '[]'::jsonb,
  failed_requests jsonb not null default '[]'::jsonb,
  elements_ok jsonb not null default '{}'::jsonb,
  screenshot_path text,
  -- true = US production server; false = local NON-US test run
  is_production boolean not null default false,
  notes text
);

create index if not exists load_checks_site_checked_idx
  on public.load_checks (site_id, checked_at desc);
create index if not exists load_checks_checked_idx
  on public.load_checks (checked_at desc);

-- Module 2: quote form end-to-end tests
create table if not exists public.form_tests (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  run_id text not null,
  tested_at timestamptz not null default now(),
  layer1_pass boolean,
  layer2_pass boolean,
  layer3_pass boolean,
  submit_to_inbox_seconds integer,
  logo_upload_ok boolean,
  screenshot_path text,
  notes text,
  is_production boolean not null default false
);

create index if not exists form_tests_site_tested_idx
  on public.form_tests (site_id, tested_at desc);

-- Incidents: open/close failures with alert tracking
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id) on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  type text not null,
  detail text,
  alerted boolean not null default false,
  last_alerted_at timestamptz,
  screenshot_path text
);

create index if not exists incidents_open_idx
  on public.incidents (site_id, opened_at desc)
  where closed_at is null;

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sites_set_updated_at on public.sites;
create trigger sites_set_updated_at
  before update on public.sites
  for each row execute function public.set_updated_at();

-- ============================================================
-- STORAGE: failure screenshots
-- ============================================================

insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

-- Anyone logged in can read screenshots; only service role writes (bypasses RLS)
create policy "Authenticated users can view screenshots"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'screenshots');

-- ============================================================
-- ROW LEVEL SECURITY (dashboard uses anon key + login)
-- Engine uses service role key and bypasses RLS.
-- ============================================================

alter table public.sites enable row level security;
alter table public.load_checks enable row level security;
alter table public.form_tests enable row level security;
alter table public.incidents enable row level security;

-- Logged-in team members can read everything
create policy "Authenticated read sites"
  on public.sites for select to authenticated using (true);
create policy "Authenticated read load_checks"
  on public.load_checks for select to authenticated using (true);
create policy "Authenticated read form_tests"
  on public.form_tests for select to authenticated using (true);
create policy "Authenticated read incidents"
  on public.incidents for select to authenticated using (true);

-- Logged-in team members can manage sites from Settings
create policy "Authenticated insert sites"
  on public.sites for insert to authenticated with check (true);
create policy "Authenticated update sites"
  on public.sites for update to authenticated using (true) with check (true);
create policy "Authenticated delete sites"
  on public.sites for delete to authenticated using (true);

-- ============================================================
-- WATCHDOG helper (engine-down detection)
-- Call from a Supabase scheduled Edge Function every 15 minutes.
-- If no load_checks in 45 minutes, insert an incident.
-- ============================================================

create or replace function public.check_engine_watchdog()
returns void
language plpgsql
security definer
as $$
declare
  last_check timestamptz;
  open_count integer;
begin
  select max(checked_at) into last_check from public.load_checks where is_production = true;

  if last_check is null or last_check < now() - interval '45 minutes' then
    select count(*) into open_count
    from public.incidents
    where type = 'engine_down' and closed_at is null;

    if open_count = 0 then
      -- Attach to first active site so the FK is satisfied
      insert into public.incidents (site_id, type, detail, alerted)
      select id, 'engine_down',
        'No production load_checks in the last 45 minutes. The checker engine may be down.',
        false
      from public.sites
      where active = true
      order by created_at
      limit 1;
    end if;
  else
    -- Engine is healthy again — close open engine_down incidents
    update public.incidents
    set closed_at = now()
    where type = 'engine_down' and closed_at is null;
  end if;
end;
$$;

-- ============================================================
-- NIGHTLY CLEANUP: delete rows/screenshots older than 30 days
-- ============================================================

create or replace function public.cleanup_old_monitoring_data()
returns void
language plpgsql
security definer
as $$
begin
  delete from public.load_checks where checked_at < now() - interval '30 days';
  delete from public.form_tests where tested_at < now() - interval '30 days';
  -- Close very old open incidents for hygiene
  update public.incidents
  set closed_at = now(),
      detail = coalesce(detail, '') || ' [auto-closed after 30 days]'
  where closed_at is null and opened_at < now() - interval '30 days';
end;
$$;
