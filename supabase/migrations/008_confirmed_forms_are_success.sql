-- A captured Layer 1 confirmation is definitive form-success evidence.
-- Preserve egress_verified=false and location metadata as warnings, but do
-- not classify a confirmed submission as a monitor error.
update public.form_tests
set outcome = 'success'
where layer1_pass is true
  and outcome = 'monitor_error';
