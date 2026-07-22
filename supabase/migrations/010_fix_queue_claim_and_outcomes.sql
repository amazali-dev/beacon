-- Make queue claims return stable JSON for PostgREST, and keep service-role
-- checks compatible with how the engine authenticates.

create or replace function public.claim_next_check_job(
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

  return jsonb_build_object(
    'id', v_job.id,
    'job_type', v_job.job_type,
    'site_id', v_job.site_id,
    'status', v_job.status,
    'requested_at', v_job.requested_at,
    'attempts', v_job.attempts,
    'runner_id', v_job.runner_id
  );
end;
$$;

revoke all on function public.claim_next_check_job(text, integer) from public, anon, authenticated;
grant execute on function public.claim_next_check_job(text, integer) to service_role;
