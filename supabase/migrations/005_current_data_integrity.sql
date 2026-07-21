-- Beacon current-data integrity, queue leases, proxy management and retention.
-- Secret-free and safe to keep in version control.

-- Structured evidence attached to every monitor result.
alter table public.load_checks
  add column if not exists outcome text,
  add column if not exists page_url text,
  add column if not exists workflow_run_id text,
  add column if not exists commit_sha text,
  add column if not exists direct_status integer,
  add column if not exists fallback_status integer,
  add column if not exists proxy_used boolean not null default false,
  add column if not exists egress_verified boolean not null default false;

alter table public.form_tests
  add column if not exists outcome text,
  add column if not exists workflow_run_id text,
  add column if not exists commit_sha text,
  add column if not exists direct_status integer,
  add column if not exists fallback_status integer,
  add column if not exists proxy_used boolean not null default false,
  add column if not exists egress_verified boolean not null default false;

update public.load_checks
set outcome = case
  when status_code = 429 then 'rate_limited'
  when loaded and status_code between 200 and 399 then 'success'
  else 'site_failure'
end
where outcome is null;

update public.form_tests
set outcome = case
  when layer1_pass is true then 'success'
  when notes ~* 'SKIPPED.*rate.?limit|CDN rate-limited|HTTP 429' then 'rate_limited'
  when layer1_pass is false then 'site_failure'
  else 'monitor_error'
end
where outcome is null;

alter table public.load_checks alter column outcome set default 'monitor_error';
alter table public.form_tests alter column outcome set default 'monitor_error';
alter table public.load_checks alter column outcome set not null;
alter table public.form_tests alter column outcome set not null;

alter table public.load_checks
  drop constraint if exists load_checks_outcome_check;
alter table public.load_checks
  add constraint load_checks_outcome_check
  check (outcome in ('success', 'site_failure', 'rate_limited', 'monitor_error', 'skipped'));

alter table public.form_tests
  drop constraint if exists form_tests_outcome_check;
alter table public.form_tests
  add constraint form_tests_outcome_check
  check (outcome in ('success', 'site_failure', 'rate_limited', 'monitor_error', 'skipped'));

create index if not exists load_checks_production_time_idx
  on public.load_checks (is_production, checked_at desc, id desc);
create index if not exists form_tests_production_time_idx
  on public.form_tests (is_production, tested_at desc, id desc);

-- Staging runs must never share incident state with production.
alter table public.incidents
  add column if not exists is_production boolean not null default true;

create unique index if not exists incidents_one_open_per_environment_idx
  on public.incidents (site_id, type, is_production)
  where closed_at is null;

-- Completed workflow runs let the UI distinguish a heartbeat from fresh data.
create table if not exists public.monitor_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  job_type text not null,
  status text not null check (status in ('running', 'completed', 'partial', 'failed', 'skipped')),
  is_production boolean not null default false,
  country text,
  ip text,
  commit_sha text,
  workflow_run_id text,
  expected_checks integer,
  completed_checks integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  detail text
);
create index if not exists monitor_runs_job_completed_idx
  on public.monitor_runs (job_type, is_production, completed_at desc);
alter table public.monitor_runs enable row level security;
drop policy if exists "Authenticated read monitor_runs" on public.monitor_runs;
create policy "Authenticated read monitor_runs"
  on public.monitor_runs for select to authenticated using (true);

create table if not exists public.schedule_slots (
  job_type text not null,
  slot_key text not null,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'claimed',
  detail text,
  primary key (job_type, slot_key)
);
alter table public.schedule_slots enable row level security;
drop policy if exists "Authenticated read schedule slots" on public.schedule_slots;
create policy "Authenticated read schedule slots"
  on public.schedule_slots for select to authenticated using (true);

create table if not exists public.operational_alerts (
  key text primary key,
  detail text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  last_alerted_at timestamptz
);
alter table public.operational_alerts enable row level security;
drop policy if exists "Authenticated read operational alerts" on public.operational_alerts;
create policy "Authenticated read operational alerts"
  on public.operational_alerts for select to authenticated using (true);

create or replace function public.claim_schedule_slot(p_job_type text, p_slot_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  insert into public.schedule_slots(job_type, slot_key)
  values (p_job_type, p_slot_key)
  on conflict do nothing;
  return found;
end;
$$;
revoke all on function public.claim_schedule_slot(text, text) from public, anon, authenticated;
grant execute on function public.claim_schedule_slot(text, text) to service_role;

create or replace function public.complete_schedule_slot(
  p_job_type text,
  p_slot_key text,
  p_success boolean,
  p_detail text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.schedule_slots
  set status = case when p_success then 'completed' else 'failed' end,
      completed_at = now(),
      detail = left(p_detail, 1000)
  where job_type = p_job_type and slot_key = p_slot_key;
end;
$$;
revoke all on function public.complete_schedule_slot(text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.complete_schedule_slot(text, text, boolean, text) to service_role;

-- Atomic queue leases; crashed runners can be reclaimed after lease expiry.
alter table public.check_jobs
  add column if not exists lease_expires_at timestamptz,
  add column if not exists runner_id text,
  add column if not exists attempts integer not null default 0,
  add column if not exists site_id uuid references public.sites(id) on delete set null;

create or replace function public.claim_next_check_job(
  p_runner_id text,
  p_lease_minutes integer default 65
)
returns public.check_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.check_jobs;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  update public.check_jobs
  set status = 'pending',
      notes = coalesce(notes || ' | ', '') || 'Recovered after expired runner lease',
      started_at = null,
      lease_expires_at = null,
      runner_id = null
  where status = 'running'
    and lease_expires_at < now();

  select * into v_job
  from public.check_jobs
  where status = 'pending'
  order by requested_at
  for update skip locked
  limit 1;

  if v_job.id is null then
    return null;
  end if;

  update public.check_jobs
  set status = 'running',
      started_at = now(),
      lease_expires_at = now() + make_interval(mins => greatest(5, p_lease_minutes)),
      runner_id = p_runner_id,
      attempts = attempts + 1
  where id = v_job.id
  returning * into v_job;

  return v_job;
end;
$$;
revoke all on function public.claim_next_check_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_next_check_job(text, integer) to service_role;

-- Persistent proxy health and credential-safe management.
create table if not exists public.proxy_health (
  proxy_id text primary key,
  blocked_until timestamptz,
  failure_count integer not null default 0,
  last_failure text,
  last_used_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.proxy_health enable row level security;
drop policy if exists "Authenticated read proxy health" on public.proxy_health;
create policy "Authenticated read proxy health"
  on public.proxy_health for select to authenticated using (true);

create or replace function public.list_proxy_pool_metadata()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_pool jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select coalesce(decrypted_secret::jsonb, '[]'::jsonb) into v_pool
  from vault.decrypted_secrets where name = 'beacon_proxy_pool';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', value->>'id',
      'label', value->>'label',
      'server', value->>'server',
      'username_hint', case
        when coalesce(value->>'username', '') = '' then null
        else left(value->>'username', 2) || '••••'
      end
    ) order by ordinality)
    from jsonb_array_elements(v_pool) with ordinality
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.list_proxy_pool_metadata() from public, anon;
grant execute on function public.list_proxy_pool_metadata() to authenticated;

create or replace function public.remove_proxy_from_pool(p_proxy_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_pool jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select id, decrypted_secret::jsonb into v_secret_id, v_pool
  from vault.decrypted_secrets where name = 'beacon_proxy_pool';
  if v_secret_id is null then return jsonb_build_object('proxy_count', 0); end if;

  select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
  into v_next
  from jsonb_array_elements(v_pool) with ordinality
  where value->>'id' is distinct from p_proxy_id;

  v_count := jsonb_array_length(v_next);
  perform vault.update_secret(v_secret_id, v_next::text, 'beacon_proxy_pool',
    'Encrypted Beacon fallback proxy credentials');
  update public.proxy_settings
  set proxy_count = v_count,
      enabled = enabled and v_count > 0,
      updated_at = now(),
      updated_by = auth.uid()
  where singleton = true;
  delete from public.proxy_health where proxy_id = p_proxy_id;
  return jsonb_build_object('proxy_count', v_count);
end;
$$;
revoke all on function public.remove_proxy_from_pool(text) from public, anon;
grant execute on function public.remove_proxy_from_pool(text) to authenticated;

create or replace function public.record_proxy_failure(
  p_proxy_id text,
  p_reason text,
  p_cooldown_minutes integer default 120
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  insert into public.proxy_health(proxy_id, blocked_until, failure_count, last_failure, last_used_at)
  values (p_proxy_id, now() + make_interval(mins => greatest(5, p_cooldown_minutes)), 1,
          left(p_reason, 500), now())
  on conflict (proxy_id) do update set
    blocked_until = excluded.blocked_until,
    failure_count = public.proxy_health.failure_count + 1,
    last_failure = excluded.last_failure,
    last_used_at = now(),
    updated_at = now();
end;
$$;
revoke all on function public.record_proxy_failure(text, text, integer) from public, anon, authenticated;
grant execute on function public.record_proxy_failure(text, text, integer) to service_role;

-- PATs do not belong in browser-readable app settings.
delete from public.app_settings where key = 'github_dispatch_token';

-- Form checks are required every two hours in US Eastern time.
insert into public.app_settings(key, value, updated_at)
values (
  'formTestTimesEastern',
  '["00:00","02:00","04:00","06:00","08:00","10:00","12:00","14:00","16:00","18:00","20:00","22:00"]'::jsonb,
  now()
)
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;

-- Screenshots require authenticated signed URLs.
update storage.buckets set public = false where id = 'screenshots';

create or replace function public.cleanup_old_monitoring_data()
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  delete from storage.objects
  where bucket_id = 'screenshots'
    and created_at < now() - interval '30 days';
  delete from public.load_checks where checked_at < now() - interval '30 days';
  delete from public.form_tests where tested_at < now() - interval '30 days';
  update public.incidents
  set closed_at = now(),
      detail = coalesce(detail, '') || ' [auto-closed after 30 days]'
  where closed_at is null and opened_at < now() - interval '30 days';
end;
$$;
revoke all on function public.cleanup_old_monitoring_data() from public, anon, authenticated;
grant execute on function public.cleanup_old_monitoring_data() to service_role;
