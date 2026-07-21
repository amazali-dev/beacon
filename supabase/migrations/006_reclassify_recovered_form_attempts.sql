-- Historical form runs that recovered from a direct 429 through an HTTP 2xx
-- fallback were incorrectly classified from note text alone. If submission
-- subsequently failed because the final control was not found, the site/form
-- outcome is a failure, not a rate-limit skip.
update public.form_tests
set outcome = 'site_failure'
where outcome = 'rate_limited'
  and notes ~* 'Attempt 2 .*HTTP 2[0-9][0-9]'
  and notes ~* 'Form test failed to run: Submit button not found|Required form submit control';
