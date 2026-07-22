-- Reduce CDN pressure: prefer hourly load cadence in runtime settings.
insert into public.app_settings(key, value, updated_at)
values ('loadCheckIntervalMinutes', '60'::jsonb, now())
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;
