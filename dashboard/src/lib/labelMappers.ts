import type { FormTest, Health, Incident, LoadCheck } from './types';

const HEALTH_ORDER: Record<Health, number> = {
  red: 0,
  yellow: 1,
  gray: 2,
  green: 3,
};

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
  const latestByProfile = new Map<string, LoadCheck>();
  for (const c of checks) {
    if (!latestByProfile.has(c.profile)) latestByProfile.set(c.profile, c);
  }
  const latest = [...latestByProfile.values()];
  const hardFail = latest.some(
    (c) =>
      (!c.loaded || (c.status_code ?? 0) >= 400) &&
      c.status_code !== 429
  );
  if (hardFail) return 'red';
  // A definite 429 is a monitor/CDN block, not confirmed website downtime.
  // A 503 remains a hard failure because it can be real service unavailability.
  if (latest.some((c) => c.status_code === 429)) return 'yellow';
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
  const latestByProfile = new Map<string, LoadCheck>();
  for (const c of checks) {
    if (!latestByProfile.has(c.profile)) latestByProfile.set(c.profile, c);
  }
  const reasons: string[] = [];
  for (const c of latestByProfile.values()) {
    if (!c.loaded || (c.status_code ?? 0) >= 400) {
      if (c.status_code === 429) {
        reasons.push(
          `${profileLabel(c.profile)}: site rate-limited the checker (HTTP ${c.status_code})`
        );
      } else {
        reasons.push(`${profileLabel(c.profile)}: site did not load`);
      }
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
  if (test.notes && /SKIPPED.*rate.?limit|CDN rate-limited|HTTP 429/i.test(test.notes)) {
    return 'Skipped — site rate-limited (not a form failure)';
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
}): string {
  const country = (row.check_country || '').toUpperCase();
  const ip = row.check_ip || '';
  if (country && ip) {
    const place =
      country === 'US' ? `United States (${country})` : `Country ${country}`;
    const kind = row.is_production ? 'GitHub Actions' : 'Local / non-production';
    return `${place} · IP ${ip} · ${kind}`;
  }
  if (country) {
    return country === 'US'
      ? `United States (${country})${row.is_production ? ' · GitHub Actions' : ''}`
      : `Country ${country}`;
  }
  if (row.is_production === true) return 'US production (location not stored on this older run)';
  if (row.is_production === false) return 'Local / non-US test (location not stored on this older run)';
  return 'Location not recorded';
}

