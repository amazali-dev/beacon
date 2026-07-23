-- Rotate one load profile every 30 minutes (desktop → Safari → mobile).
insert into public.app_settings(key, value, updated_at)
values ('loadCheckIntervalMinutes', '30'::jsonb, now())
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;
