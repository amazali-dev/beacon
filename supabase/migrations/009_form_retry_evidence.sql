-- Preserve evidence from refreshed form recovery attempts.
alter table public.form_tests
  add column if not exists attempt_screenshot_paths text[] not null default '{}';

alter table public.incidents
  add column if not exists screenshot_paths text[] not null default '{}';
