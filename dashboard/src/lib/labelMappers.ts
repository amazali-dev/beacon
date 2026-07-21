import type { FormTest, Health, Incident, LoadCheck } from './types';

const HEALTH_ORDER: Record<Health, number> = {
  red: 0,
  yellow: 1,
  gray: 2,
  green: 3,
};
export const CURRENT_DATA_MAX_AGE_MS = 75 * 60 * 1000;

function isExcludedMonitorResult(check: LoadCheck): boolean {
  return check.status_code === 429 || check.outcome === 'rate_limited' || check.outcome === 'monitor_error';
}

function latestAssessedByProfile(checks: LoadCheck[]): LoadCheck[] {
  const latest = new Map<string, LoadCheck>();
  for (const check of checks) {
    if (isExcludedMonitorResult(check) || latest.has(check.profile)) continue;
    latest.set(check.profile, check);
  }
  return [...latest.values()];
}

export function healthSortOrder(health: Health): number {
  return HEALTH_ORDER[health];
}

export function healthLabel(health: Health): string {
  switch (health) {
    case 'green':
      return 'Healthy';
    case 'yellow':
      return 'Needs attention';
    case 'red':
      return 'Down';
    case 'gray':
      return 'No data';
  }
}

export function healthFromChecks(checks: LoadCheck[], slowThresholdMs = 8000): Health {
  if (checks.length === 0) return 'gray';
  const latest = latestAssessedByProfile(checks);
  if (!latest.length) return 'gray';
  if (
    latest.some(
      (check) => Date.now() - new Date(check.checked_at).getTime() > CURRENT_DATA_MAX_AGE_MS
    )
  ) {
    return 'gray';
  }
  const hardFail = latest.some(
    (c) =>
      (!c.loaded || (c.status_code ?? 0) >= 400) &&
      c.status_code !== 429
  );
  if (hardFail) return 'red';
  if (
    latest.some(
      (c) =>
        c.elements_ok?.cta === false ||
        c.elements_ok?.quote_form === false ||
        (c.load_ms ?? 0) > slowThresholdMs
    )
  ) {
    return 'yellow';
  }
  return 'green';
}

export function healthReasons(checks: LoadCheck[], slowThresholdMs = 8000): string[] {
  if (checks.length === 0) return ['No load checks yet'];
  const latest = latestAssessedByProfile(checks);
  if (!latest.length) return ['No recent assessed visits — monitor was blocked or could not run'];
  const reasons: string[] = [];
  for (const c of latest) {
    if (Date.now() - new Date(c.checked_at).getTime() > CURRENT_DATA_MAX_AGE_MS) {
      reasons.push(`${profileLabel(c.profile)}: data is stale (${formatAge(c.checked_at)})`);
      continue;
    }
    if (!c.loaded || (c.status_code ?? 0) >= 400) {
      reasons.push(`${profileLabel(c.profile)}: site did not load`);
    } else if (c.elements_ok?.cta === false) {
      reasons.push(`${profileLabel(c.profile)}: Get a Quote button not found`);
    } else if (c.elements_ok?.quote_form === false) {
      reasons.push(`${profileLabel(c.profile)}: quote form not found`);
    } else if ((c.load_ms ?? 0) > slowThresholdMs) {
      reasons.push(`${profileLabel(c.profile)}: slow (${c.load_ms}ms)`);
    }
  }
  return reasons.length ? reasons : ['All profiles healthy'];
}

function formatAge(iso: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return minutes < 120 ? `${minutes} minutes old` : `${Math.round(minutes / 60)} hours old`;
}

export function profileLabel(profile: string): string {
  switch (profile) {
    case 'desktop':
      return 'Desktop';
    case 'webkit':
      return 'Safari';
    case 'mobile':
      return 'Mobile';
    default:
      return profile;
  }
}

export function incidentTypeLabel(type: string): string {
  switch (type) {
    case 'form_test_failure':
      return 'Form test failed';
    case 'load_check_failure':
    case 'load_failure':
      return 'Load check failed';
    case 'rate_limited':
      return 'Site rate-limited monitor';
    case 'slow_load':
      return 'Slow load';
    default:
      return type.replace(/_/g, ' ');
  }
}

export function passLabel(v: boolean | null): string {
  if (v === true) return 'Pass';
  if (v === false) return 'Fail';
  return 'Skipped';
}

export function formLayerLabels(test: FormTest): {
  submitted: string;
  email: string;
  crm: string;
} {
  return {
    submitted: passLabel(test.layer1_pass),
    email: passLabel(test.layer2_pass),
    crm: passLabel(test.layer3_pass),
  };
}

export function formTestSummary(test: FormTest): string {
  if (test.outcome === 'monitor_error') {
    return 'Monitor could not complete this test';
  }
  if (
    test.outcome === 'rate_limited' ||
    (!test.outcome &&
      test.notes &&
      /SKIPPED.*rate.?limit|CDN rate-limited|HTTP 429/i.test(test.notes))
  ) {
    return 'Skipped — site rate-limited (not a form failure)';
  }
  if (test.outcome === 'site_failure' && test.layer1_pass !== true) {
    return 'Form submission failed';
  }

  const parts: string[] = [];

  // Layer 1 — did the quote form submit and show a thank-you page?
  if (test.layer1_pass === true) parts.push('Form submitted OK');
  else if (test.layer1_pass === false) parts.push('Form submit failed');

  // Layer 2 — did the lead email arrive? (only when inbox checking is turned on)
  if (test.layer2_pass === true) parts.push('Lead email received');
  else if (test.layer2_pass === false) parts.push('Lead email missing');

  if (test.logo_upload_ok === false) parts.push('Logo upload failed');
  else if (test.logo_upload_ok === true) parts.push('Logo uploaded OK');

  return parts.length ? parts.join(' · ') : 'Form test incomplete';
}

/** Short plain-English explainers for form layer results (for tooltips / detail). */
export function formLayerExplainer(layer: 'submit' | 'email' | 'crm', value: boolean | null): string {
  if (layer === 'submit') {
    if (value === true) return 'The form filled and submitted, and a thank-you / confirmation appeared.';
    if (value === false) return 'The form did not submit successfully (no thank-you page in time).';
    return 'Submit step was not completed in this run.';
  }
  if (layer === 'email') {
    if (value === true) return 'The lead notification email arrived in the test inbox.';
    if (value === false) return 'Expected lead email did not arrive in time.';
    return 'Inbox checking is off — we do not look for the email yet (optional Layer 2).';
  }
  if (value === true) return 'CRM check passed.';
  if (value === false) return 'CRM check failed.';
  return 'CRM check is not connected yet (optional Layer 3).';
}

export function formTestPassed(test: FormTest): boolean {
  if (test.layer1_pass === false) return false;
  if (test.layer2_pass === false) return false;
  return test.layer1_pass === true;
}

export function incidentDetailPlain(incident: Incident): string {
  return incident.detail || incidentTypeLabel(incident.type);
}

export function detectionStatusLabel(site: {
  form_selectors?: Record<string, string>;
  form_testing_enabled: boolean;
}): string {
  if (!site.form_testing_enabled) return 'Form testing off';
  const keys = Object.keys(site.form_selectors || {});
  if (keys.length >= 3) return 'Form test fields ready';
  return 'Needs form field detection';
}

/** Where the checker accessed the site from (US GitHub runner vs local). */
export function formatRunLocation(row: {
  check_country?: string | null;
  check_ip?: string | null;
  is_production?: boolean | null;
  proxy_used?: boolean | null;
}): string {
  const country = (row.check_country || '').toUpperCase();
  const ip = row.check_ip || '';
  if (country && ip) {
    const place =
      country === 'US' ? `United States (${country})` : `Country ${country}`;
    const kind = row.proxy_used
      ? 'Fallback proxy egress'
      : row.is_production
        ? 'GitHub Actions'
        : 'Local / non-production';
    return `${place} · IP ${ip} · ${kind}`;
  }
  if (country) {
    return country === 'US'
      ? `United States (${country})${row.proxy_used ? ' · Fallback proxy egress' : row.is_production ? ' · GitHub Actions' : ''}`
      : `Country ${country}`;
  }
  if (row.is_production === true) return 'Production run (egress location not verified on this older row)';
  if (row.is_production === false) return 'Local / non-US test (location not stored on this older run)';
  return 'Location not recorded';
}

