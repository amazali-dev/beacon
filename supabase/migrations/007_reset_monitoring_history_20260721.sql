-- One-time monitoring-history reset requested on 2026-07-21.
-- Preserve all configuration: sites/selectors, app settings, auth users,
-- proxy settings, proxy Vault credentials, and proxy health/cooldowns.

delete from public.incidents;
delete from public.load_checks;
delete from public.form_tests;
delete from public.monitor_runs;
delete from public.check_jobs;
delete from public.schedule_slots;
delete from public.operational_alerts;

-- Keep settings rows and configured values, but clear stale runtime telemetry
-- so the dashboard remains blank until the next genuine production run.
update public.app_settings
set value = 'null'::jsonb,
    updated_at = now()
where key in (
  'engine_heartbeat',
  'engine_geo_country',
  'engine_geo_ip',
  'engine_geo_label',
  'engine_geo_source'
);
