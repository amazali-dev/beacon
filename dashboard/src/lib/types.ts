export type Site = {
  id: string;
  name: string;
  main_url: string;
  extra_urls: string[];
  quote_form_url: string | null;
  form_testing_enabled: boolean;
  selectors: Record<string, string>;
  form_selectors: Record<string, string>;
  form_detection_status: Record<string, unknown>;
  active: boolean;
};

export type LoadCheck = {
  id: string;
  site_id: string;
  profile: string;
  checked_at: string;
  status_code: number | null;
  loaded: boolean;
  load_ms: number | null;
  lcp_ms: number | null;
  cls: number | null;
  console_errors: unknown;
  failed_requests: unknown;
  elements_ok: Record<string, boolean>;
  screenshot_path: string | null;
  is_production: boolean;
  notes: string | null;
};

export type FormTest = {
  id: string;
  site_id: string;
  run_id: string;
  tested_at: string;
  layer1_pass: boolean | null;
  layer2_pass: boolean | null;
  layer3_pass: boolean | null;
  submit_to_inbox_seconds: number | null;
  logo_upload_ok: boolean | null;
  screenshot_path: string | null;
  notes: string | null;
};

export type Incident = {
  id: string;
  site_id: string;
  opened_at: string;
  closed_at: string | null;
  type: string;
  detail: string | null;
  alerted: boolean;
  screenshot_path: string | null;
};

export type Health = 'green' | 'yellow' | 'red' | 'gray';
