import { describe, expect, it } from 'vitest';
import { healthFromChecks } from './labelMappers';
import { calculateWebsiteHealth, isRateLimitedFormTest } from './healthScoring';
import type { FormTest, LoadCheck } from './types';

function check(overrides: Partial<LoadCheck> = {}): LoadCheck {
  return {
    id: crypto.randomUUID(),
    site_id: 'site-1',
    profile: 'desktop',
    checked_at: new Date().toISOString(),
    status_code: 200,
    loaded: true,
    load_ms: 1000,
    lcp_ms: 900,
    cls: 0.02,
    console_errors: [],
    failed_requests: [],
    elements_ok: { logo: true, headline: true, cta: true },
    screenshot_path: null,
    is_production: true,
    notes: null,
    outcome: 'success',
    ...overrides,
  };
}

describe('current production health', () => {
  it('ignores a newest rate-limit row and uses recent site evidence', () => {
    expect(
      healthFromChecks([
        check({ id: 'new', status_code: 429, loaded: false, outcome: 'rate_limited' }),
        check({ id: 'old', checked_at: new Date(Date.now() - 60_000).toISOString() }),
      ])
    ).toBe('green');
  });

  it('marks old successful evidence stale', () => {
    expect(
      healthFromChecks([
        check({ checked_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }),
      ])
    ).toBe('gray');
  });

  it('does not count rate limits or monitor errors as assessed visits', () => {
    const result = calculateWebsiteHealth([
      check(),
      check({ status_code: 429, loaded: false, outcome: 'rate_limited' }),
      check({ status_code: null, loaded: false, outcome: 'monitor_error' }),
    ]);
    expect(result.assessedVisits).toBe(1);
    expect(result.availability.score).toBe(100);
  });

  it('keeps a successful proxy recovery as a win despite direct 429 notes', () => {
    const form: FormTest = {
      id: 'form-1',
      site_id: 'site-1',
      run_id: 'MON-1',
      tested_at: new Date().toISOString(),
      layer1_pass: true,
      layer2_pass: null,
      layer3_pass: null,
      submit_to_inbox_seconds: null,
      logo_upload_ok: true,
      screenshot_path: null,
      notes: 'Attempt 1 direct was rate-limited (HTTP 429). Attempt 2 fallback: HTTP 200.',
      outcome: 'success',
    };
    expect(isRateLimitedFormTest(form)).toBe(false);
  });
});
