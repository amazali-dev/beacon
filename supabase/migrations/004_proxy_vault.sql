-- Secure fallback proxy pool for Beacon.
-- Run once in Supabase SQL Editor. The dashboard can save/disable the pool,
-- but only the service-role engine can decrypt it.

create extension if not exists supabase_vault with schema vault;

create table if not exists public.proxy_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  proxy_count integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- Remove the original 10-proxy cap if this migration was already run.
alter table public.proxy_settings
  drop constraint if exists proxy_settings_proxy_count_check;
alter table public.proxy_settings
  add constraint proxy_settings_proxy_count_check check (proxy_count >= 0);

alter table public.proxy_settings enable row level security;

drop policy if exists "Authenticated users can view proxy status" on public.proxy_settings;
create policy "Authenticated users can view proxy status"
  on public.proxy_settings
  for select
  to authenticated
  using (true);

insert into public.proxy_settings (singleton, enabled, proxy_count)
values (true, false, 0)
on conflict (singleton) do nothing;

create or replace function public.save_proxy_pool(
  p_enabled boolean,
  p_pool jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_count integer;
  v_secret_id uuid;
  v_entry jsonb;
  v_server text;
  v_existing_pool jsonb := '[]'::jsonb;
  v_combined_pool jsonb := '[]'::jsonb;
  v_saved_pool jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- A null pool only changes enabled/disabled state and preserves credentials.
  if p_pool is not null then
    if jsonb_typeof(p_pool) <> 'array' then
      raise exception 'Proxy pool must be a JSON array';
    end if;

    for v_entry in select value from jsonb_array_elements(p_pool)
    loop
      v_server := trim(v_entry->>'server');
      if v_server is null
         or v_server !~* '^https?://[^[:space:]]+(:[0-9]+)?$'
         or v_server ~ '@' then
        raise exception 'Each proxy requires an http(s) server without embedded credentials';
      end if;
      if coalesce(length(v_entry->>'username'), 0) > 500
         or coalesce(length(v_entry->>'password'), 0) > 500 then
        raise exception 'Proxy credentials are too long';
      end if;
    end loop;

    select id into v_secret_id
    from vault.secrets
    where name = 'beacon_proxy_pool';

    if v_secret_id is not null then
      select coalesce(decrypted_secret::jsonb, '[]'::jsonb)
      into v_existing_pool
      from vault.decrypted_secrets
      where id = v_secret_id;
    end if;

    -- New entries are appended. For the same server + username, the newest
    -- entry wins so saving updated credentials does not create duplicates.
    v_combined_pool := coalesce(v_existing_pool, '[]'::jsonb) || p_pool;
    with entries as (
      select
        value,
        ordinality,
        concat(value->>'server', E'\n', coalesce(value->>'username', '')) as proxy_key
      from jsonb_array_elements(v_combined_pool) with ordinality
    ),
    newest as (
      select distinct on (proxy_key)
        value,
        ordinality
      from entries
      order by proxy_key, ordinality desc
    )
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into v_saved_pool
    from newest;

    v_count := jsonb_array_length(v_saved_pool);

    if v_secret_id is null then
      perform vault.create_secret(
        v_saved_pool::text,
        'beacon_proxy_pool',
        'Encrypted Beacon fallback proxy credentials'
      );
    else
      perform vault.update_secret(
        v_secret_id,
        v_saved_pool::text,
        'beacon_proxy_pool',
        'Encrypted Beacon fallback proxy credentials'
      );
    end if;
  else
    select proxy_count into v_count
    from public.proxy_settings
    where singleton = true;
    v_count := coalesce(v_count, 0);
  end if;

  insert into public.proxy_settings (
    singleton,
    enabled,
    proxy_count,
    updated_at,
    updated_by
  )
  values (
    true,
    coalesce(p_enabled, false) and v_count > 0,
    v_count,
    now(),
    auth.uid()
  )
  on conflict (singleton) do update set
    enabled = excluded.enabled,
    proxy_count = excluded.proxy_count,
    updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;

  return jsonb_build_object(
    'enabled', coalesce(p_enabled, false) and v_count > 0,
    'proxy_count', v_count
  );
end;
$$;

create or replace function public.get_proxy_pool()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_enabled boolean := false;
  v_pool jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select enabled into v_enabled
  from public.proxy_settings
  where singleton = true;

  if coalesce(v_enabled, false) then
    select decrypted_secret::jsonb into v_pool
    from vault.decrypted_secrets
    where name = 'beacon_proxy_pool';
  end if;

  return jsonb_build_object(
    'enabled', coalesce(v_enabled, false),
    'pool', coalesce(v_pool, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.save_proxy_pool(boolean, jsonb) from public, anon;
grant execute on function public.save_proxy_pool(boolean, jsonb) to authenticated;

revoke all on function public.get_proxy_pool() from public, anon, authenticated;
grant execute on function public.get_proxy_pool() to service_role;

revoke all on public.proxy_settings from anon;
grant select on public.proxy_settings to authenticated;
