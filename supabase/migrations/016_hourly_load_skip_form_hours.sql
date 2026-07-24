-- Hourly load checks; forms stay every 2 hours Eastern.
-- Scheduled loads skip Eastern hours that have a form slot (see engine skip logic).

insert into public.app_settings(key, value, updated_at)
values
  ('loadCheckIntervalMinutes', '60'::jsonb, now()),
  (
    'formTestTimesEastern',
    '["00:00","02:00","04:00","06:00","08:00","10:00","12:00","14:00","16:00","18:00","20:00","22:00"]'::jsonb,
    now()
  )
on conflict (key) do update
set value = excluded.value,
    updated_at = excluded.updated_at;
