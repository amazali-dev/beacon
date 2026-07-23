import type { FormTest, LoadCheck, Site } from './types';
import { formTestPassed, formTestSummary, formatRunLocation } from './labelMappers';

export type Tone = 'ok' | 'bad' | 'warn' | 'muted';

export function formSummaryBadges(test: FormTest): Array<{ label: string; tone: Tone }> {
  const summary = formTestSummary(test);
  if (
    summary === 'Monitor could not complete this test' ||
    summary.startsWith('Skipped') ||
    summary === 'Form submission failed' ||
    summary === 'Form test incomplete'
  ) {
    const tone: Tone =
      summary.startsWith('Skipped') || summary === 'Form test incomplete' ? 'muted' : 'bad';
    return [{ label: summary, tone }];
  }

  return summary.split(' · ').filter(Boolean).map((label) => {
    const lower = label.toLowerCase();
    if (lower.includes('failed') || lower.includes('missing')) return { label, tone: 'bad' as const };
    if (lower.includes('ok') || lower.includes('received')) return { label, tone: 'ok' as const };
    return { label, tone: 'muted' as const };
  });
}

export function splitFormNoteSteps(notes: string | null | undefined): string[] {
  if (!notes?.trim()) return [];
  return notes
    .split(/\s*\|\s*/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function parseFormNoteMeta(notes: string | null | undefined): {
  fallback: string | null;
  http: string | null;
} {
  const text = notes || '';
  const fallback =
    text.match(/Fallback\s+(\d+)/i)?.[1] ??
    text.match(/uses\s+Fallback\s+(\d+)/i)?.[1] ??
    null;
  const http = text.match(/HTTP\s+(\d+|no response)/i)?.[1] ?? null;
  return { fallback, http };
}

export function formCardTone(test: FormTest): Tone {
  if (test.outcome === 'rate_limited' || test.outcome === 'monitor_error') return 'muted';
  if (
    !test.outcome &&
    test.notes &&
    /SKIPPED.*rate.?limit|CDN rate-limited|HTTP 429/i.test(test.notes)
  ) {
    return 'muted';
  }
  if (formTestPassed(test)) return 'ok';
  if (test.outcome === 'site_failure' || test.layer1_pass === false) return 'bad';
  return 'muted';
}

export function formRunLocationParts(row: {
  check_country?: string | null;
  check_ip?: string | null;
  is_production?: boolean | null;
  proxy_used?: boolean | null;
}): { location: string; proxy: string } {
  const full = formatRunLocation(row);
  const proxy = row.proxy_used
    ? 'Fallback proxy egress'
    : row.is_production
      ? 'GitHub Actions'
      : row.is_production === false
        ? 'Local / non-production'
        : '—';
  const location = full
    .replace(/\s*·\s*Fallback proxy egress$/i, '')
    .replace(/\s*·\s*GitHub Actions$/i, '')
    .replace(/\s*·\s*Local \/ non-production$/i, '')
    .trim();
  return { location: location || full, proxy };
}

export function brandFromRunId(runId: string): string {
  const m = runId.match(/^([A-Za-z][A-Za-z0-9]*)[-_]/);
  return m?.[1]?.toUpperCase() || '—';
}

export function formFieldsStatus(site: Site): { label: string; tone: Tone } {
  if (!site.form_testing_enabled) return { label: 'Off', tone: 'muted' };
  const keys = Object.keys(site.form_selectors || {}).length;
  if (keys >= 3) return { label: 'Ready', tone: 'ok' };
  return { label: 'Needs detection', tone: 'warn' };
}

export function formDetectionStatus(site: Site): { label: string; tone: Tone } {
  if (!site.form_testing_enabled) return { label: 'Off', tone: 'muted' };
  const keys = Object.keys(site.form_selectors || {}).length;
  if (keys >= 3) return { label: 'Configured', tone: 'ok' };
  const raw = site.form_detection_status;
  if (raw && typeof raw === 'object') {
    const status = String((raw as Record<string, unknown>).status || (raw as Record<string, unknown>).state || '');
    if (status) return { label: status.replace(/_/g, ' '), tone: 'warn' };
  }
  return { label: 'Needs detection', tone: 'warn' };
}

export function loadCheckDisplay(
  check: LoadCheck,
  slowThresholdMs: number
): { label: string; chip: string; tone: Tone; seconds: string; barPct: number } {
  const ms = check.load_ms;
  const seconds = ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`;
  const shortSec = ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
  const barPct =
    ms == null || slowThresholdMs <= 0 ? 0 : Math.min(100, Math.round((ms / slowThresholdMs) * 100));

  if (check.status_code === 429) {
    return {
      label: `Rate limited (HTTP ${check.status_code})`,
      chip: `Rate limited (HTTP ${check.status_code})`,
      tone: 'muted',
      seconds,
      barPct,
    };
  }
  if (!check.loaded || (check.status_code ?? 0) >= 400) {
    const failed = `Failed (${check.status_code ?? 'no status'})`;
    return { label: failed, chip: failed, tone: 'bad', seconds, barPct };
  }
  if ((ms ?? 0) > slowThresholdMs) {
    return { label: 'Slow', chip: `Slow · ${shortSec}`, tone: 'warn', seconds, barPct };
  }
  if (check.elements_ok?.cta === false || check.elements_ok?.quote_form === false) {
    return {
      label: 'Needs attention',
      chip: `Needs attention · ${shortSec}`,
      tone: 'warn',
      seconds,
      barPct,
    };
  }
  return {
    label: ms == null ? 'OK' : `OK · ${ms}ms`,
    chip: ms == null ? 'OK' : `OK · ${shortSec}`,
    tone: 'ok',
    seconds,
    barPct,
  };
}

export function egressFooterText(check: LoadCheck | FormTest | null): string | null {
  if (!check) return null;
  return `Checks run from ${formatRunLocation(check)}`;
}
