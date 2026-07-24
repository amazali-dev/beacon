-- Live Run-now progress events + hard cancel support

alter table public.check_jobs
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists github_run_id text;

alter table public.check_jobs drop constraint if exists check_jobs_status_check;
alter table public.check_jobs
  add constraint check_jobs_status_check
  check (status in ('pending', 'running', 'done', 'failed', 'cancelled'));

create table if not exists public.check_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.check_jobs(id) on delete cascade,
  seq integer not null,
  site_id uuid references public.sites(id) on delete set null,
  site_name text,
  phase text not null check (phase in ('site_start', 'step', 'site_done', 'job_done', 'error')),
  message text not null,
  created_at timestamptz not null default now(),
  unique (job_id, seq)
);

create index if not exists check_job_events_job_seq_idx
  on public.check_job_events (job_id, seq);

alter table public.check_job_events enable row level security;

drop policy if exists "Authenticated read check_job_events" on public.check_job_events;
create policy "Authenticated read check_job_events"
  on public.check_job_events for select to authenticated using (true);

-- Reclaim expired leases, but finalize cancelled jobs instead of re-queueing them.
-- Must DROP first: adding columns to check_jobs changes the composite return type.
drop function if exists public.claim_next_check_job(text, integer);

create function public.claim_next_check_job(
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
  set status = 'cancelled',
      completed_at = coalesce(completed_at, now()),
      notes = coalesce(notes || ' | ', '') || 'Cancelled (runner stopped after stop request)',
      lease_expires_at = null,
      runner_id = null
  where status = 'running'
    and cancel_requested_at is not null
    and lease_expires_at < now();

  update public.check_jobs
  set status = 'pending',
      notes = coalesce(notes || ' | ', '') || 'Recovered after expired runner lease',
      started_at = null,
      lease_expires_at = null,
      runner_id = null
  where status = 'running'
    and cancel_requested_at is null
    and lease_expires_at < now();

  select * into v_job
  from public.check_jobs
  where status = 'pending'
    and cancel_requested_at is null
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

-- Realtime for live Operations panel (no-op if already published)
do $$
begin
  alter publication supabase_realtime add table public.check_job_events;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
