-- Fix claim_next_check_job: must return jsonb for PostgREST (see migration 010).
-- Migration 014 accidentally restored RETURNS public.check_jobs, which serializes
-- as an all-null object and crashes the engine after claiming.

drop function if exists public.claim_next_check_job(text, integer);

create function public.claim_next_check_job(
  p_runner_id text,
  p_lease_minutes integer default 65
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.check_jobs;
  v_role text := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), '');
begin
  if v_role is distinct from 'service_role' then
    raise exception 'Service role required (got %)', coalesce(nullif(v_role, ''), 'none');
  end if;

  -- Finalize cancelled jobs whose runner died after Stop.
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

  return jsonb_build_object(
    'id', v_job.id,
    'job_type', v_job.job_type,
    'site_id', v_job.site_id,
    'status', v_job.status,
    'requested_at', v_job.requested_at,
    'attempts', v_job.attempts,
    'runner_id', v_job.runner_id,
    'cancel_requested_at', v_job.cancel_requested_at,
    'github_run_id', v_job.github_run_id
  );
end;
$$;

revoke all on function public.claim_next_check_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_next_check_job(text, integer) to service_role;

-- Mark jobs stuck "running" by the broken composite return so Run now can be used again.
update public.check_jobs
set status = 'failed',
    completed_at = now(),
    lease_expires_at = null,
    runner_id = null,
    notes = coalesce(notes || ' | ', '') || 'Failed: claim RPC returned empty payload (fixed in 015)'
where status = 'running'
  and cancel_requested_at is null
  and completed_at is null;
