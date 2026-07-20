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
  if (latest.some((c) => !c.loaded || (c.status_code ?? 0) >= 400)) return 'red';
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
      reasons.push(`${profileLabel(c.profile)}: site did not load`);
    } else if (c.elements_ok?.cta === false) {
      reasons.push(`${profileLabel(c.profile)}: CTA missing`);
    } else if (c.elements_ok?.quote_form === false) {
      reasons.push(`${profileLabel(c.profile)}: quote form missing`);
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
      return 'Load check failed';
    case 'slow_load':
      return 'Slow load';
    default:
      return type.replace(/_/g, ' ');
  }
}

export function passLabel(v: boolean | null): string {
  if (v === true) return 'Pass';
  if (v === false) return 'Fail';
  return 'Not checked';
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
  const parts: string[] = [];
  if (test.layer1_pass === true) parts.push('Submitted');
  else if (test.layer1_pass === false) parts.push('Submit failed');
  else parts.push('Submit not checked');

  if (test.layer2_pass === true) parts.push('Email received');
  else if (test.layer2_pass === false) parts.push('Email missing');
  else if (test.layer2_pass === null) parts.push('Email not checked');

  if (test.logo_upload_ok === false) parts.push('Logo upload failed');
  else if (test.logo_upload_ok === true) parts.push('Logo uploaded');

  return parts.join(' · ');
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
  if (keys.length >= 3) return 'Form fields detected';
  return 'Needs field detection';
}
