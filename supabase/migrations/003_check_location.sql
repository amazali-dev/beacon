-- Per-run location (where the checker accessed the site from).
-- Safe to re-run.

alter table public.load_checks
  add column if not exists check_country text,
  add column if not exists check_ip text;

alter table public.form_tests
  add column if not exists check_country text,
  add column if not exists check_ip text;

comment on column public.load_checks.check_country is 'ISO country from IP geo at run time (e.g. US)';
comment on column public.load_checks.check_ip is 'Public IP of the checker (GitHub runner or local)';
comment on column public.form_tests.check_country is 'ISO country from IP geo at run time (e.g. US)';
comment on column public.form_tests.check_ip is 'Public IP of the checker (GitHub runner or local)';
