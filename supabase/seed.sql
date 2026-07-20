-- Seed the 5 commercial signage sites.
-- Run AFTER 001_initial.sql. Safe to re-run (skips if name already exists).

insert into public.sites (name, main_url, extra_urls, quote_form_url, form_testing_enabled, active)
select v.name, v.main_url, v.extra_urls::jsonb, v.quote_form_url, true, true
from (values
  (
    'Signage Inc',
    'https://signage.inc/',
    '[]',
    'https://signage.inc/',
    true
  ),
  (
    'Signmakerz',
    'https://www.signmakerz.com/',
    '[]',
    'https://www.signmakerz.com/',
    true
  ),
  (
    'Signs Inc',
    'https://signs.inc/',
    '[]',
    'https://signs.inc/',
    true
  ),
  (
    'Quick Signage',
    'https://quicksignage.com/',
    '[]',
    'https://quicksignage.com/',
    true
  ),
  (
    'Signize',
    'https://signize.us/',
    '[]',
    'https://signize.us/',
    true
  )
) as v(name, main_url, extra_urls, quote_form_url, form_testing_enabled)
where not exists (
  select 1 from public.sites s where s.name = v.name
);
