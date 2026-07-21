import { supabase } from './supabase';
import {
  calculateFormHealth,
  calculateWebsiteHealth,
  isAvailableVisit,
  isMonitorRateLimit,
  isRateLimitedFormTest,
  type FormHealthScore,
  type WebsiteHealthScore,
} from './healthScoring';
import type { FormTest, LoadCheck, Site } from './types';

export type ReportRangeDays = 1 | 3 | 7 | 15 | 30;

export type ReportData = {
  sites: Site[];
  checks: LoadCheck[];
  forms: FormTest[];
};

export type ReportMetrics = {
  totalVisits: number;
  successfulVisits: number;
  failedVisits: number;
  rateLimitedVisits: number;
  contentIssueVisits: number;
  healthPercent: number | null;
  websiteHealth: WebsiteHealthScore;
  monitorConfidencePercent: number | null;
  averageLoadMs: number | null;
  p95LoadMs: number | null;
  fastestLoadMs: number | null;
  slowVisits: number;
  totalForms: number;
  successfulForms: number;
  failedForms: number;
  skippedForms: number;
  formSuccessPercent: number | null;
  formHealthPercent: number | null;
  formHealth: FormHealthScore;
};

export type DailyReportPoint = {
  key: string;
  label: string;
  total: number;
  assessed: number;
  successful: number;
  rateLimited: number;
  healthPercent: number | null;
  availabilityPercent: number | null;
  contentPercent: number | null;
  performancePercent: number | null;
  browserPercent: number | null;
  averageLoadMs: number | null;
};

const PAGE_SIZE = 1000;
const SLOW_MS = 8000;

export function reportStartIso(days: ReportRangeDays): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function fetchAllChecks(startIso: string, siteId?: string): Promise<LoadCheck[]> {
  const rows: LoadCheck[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('load_checks')
      .select('*')
      .eq('is_production', true)
      .gte('checked_at', startIso)
      .order('checked_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (siteId) query = query.eq('site_id', siteId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not load visit history: ${error.message}`);

    const page = (data || []) as LoadCheck[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return rows;
}

async function fetchAllForms(startIso: string, siteId?: string): Promise<FormTest[]> {
  const rows: FormTest[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('form_tests')
      .select('*')
      .eq('is_production', true)
      .gte('tested_at', startIso)
      .order('tested_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);

    if (siteId) query = query.eq('site_id', siteId);
    const { data, error } = await query;
    if (error) throw new Error(`Could not load form history: ${error.message}`);

    const page = (data || []) as FormTest[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return rows;
}

export async function loadReportData(
  days: ReportRangeDays,
  siteId?: string
): Promise<ReportData> {
  const startIso = reportStartIso(days);
  // Always keep the full site list available for the report site selector.
  const sitesQuery = supabase.from('sites').select('*').order('name');

  const [{ data: siteRows, error: siteError }, checks, forms] = await Promise.all([
    sitesQuery,
    fetchAllChecks(startIso, siteId),
    fetchAllForms(startIso, siteId),
  ]);

  if (siteError) throw new Error(`Could not load sites: ${siteError.message}`);
  return {
    sites: (siteRows || []) as Site[],
    checks,
    forms,
  };
}

export function isSuccessfulVisit(check: LoadCheck): boolean {
  return isAvailableVisit(check);
}

export function isRateLimitedVisit(check: LoadCheck): boolean {
  return isMonitorRateLimit(check);
}

export function hasContentIssue(check: LoadCheck): boolean {
  return check.elements_ok?.cta === false || check.elements_ok?.quote_form === false;
}

export function isRateLimitedForm(test: FormTest): boolean {
  return isRateLimitedFormTest(test);
}

function roundedAverage(values: number[]): number | null {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export function calculateReportMetrics(
  checks: LoadCheck[],
  forms: FormTest[]
): ReportMetrics {
  const websiteHealth = calculateWebsiteHealth(checks);
  const formHealth = calculateFormHealth(forms);
  const successfulVisits = checks.filter(isSuccessfulVisit).length;
  const rateLimitedVisits = checks.filter(isRateLimitedVisit).length;
  const assessedVisits = checks.length - rateLimitedVisits;
  const failedVisits = assessedVisits - successfulVisits;
  const loadTimes = checks
    .filter(isSuccessfulVisit)
    .map((check) => check.load_ms)
    .filter((value): value is number => value !== null);

  const successfulForms = forms.filter((form) => form.layer1_pass === true).length;
  const failedForms = forms.filter(
    (form) => form.layer1_pass === false && !isRateLimitedForm(form)
  ).length;
  const skippedForms = forms.length - successfulForms - failedForms;
  const decidedForms = successfulForms + failedForms;

  return {
    totalVisits: checks.length,
    successfulVisits,
    failedVisits,
    rateLimitedVisits,
    contentIssueVisits: checks.filter(hasContentIssue).length,
    healthPercent: websiteHealth.score,
    websiteHealth,
    monitorConfidencePercent: websiteHealth.confidencePercent,
    averageLoadMs: roundedAverage(loadTimes),
    p95LoadMs: percentile95(loadTimes),
    fastestLoadMs: loadTimes.length ? Math.min(...loadTimes) : null,
    slowVisits: loadTimes.filter((value) => value > SLOW_MS).length,
    totalForms: forms.length,
    successfulForms,
    failedForms,
    skippedForms,
    formSuccessPercent: decidedForms
      ? Math.round((successfulForms / decidedForms) * 10_000) / 100
      : null,
    formHealthPercent: formHealth.score,
    formHealth,
  };
}

function pakistanDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
}

export function buildDailyHistory(checks: LoadCheck[]): DailyReportPoint[] {
  const grouped = new Map<string, LoadCheck[]>();

  for (const check of checks) {
    const key = pakistanDayKey(check.checked_at);
    grouped.set(key, [...(grouped.get(key) || []), check]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const successful = rows.filter(isSuccessfulVisit);
      const rateLimited = rows.filter(isRateLimitedVisit).length;
      const assessed = rows.length - rateLimited;
      const websiteHealth = calculateWebsiteHealth(rows);
      const times = successful
        .map((row) => row.load_ms)
        .filter((value): value is number => value !== null);

      return {
        key,
        label: new Date(`${key}T12:00:00+05:00`).toLocaleDateString('en-PK', {
          month: 'short',
          day: 'numeric',
          timeZone: 'Asia/Karachi',
        }),
        total: rows.length,
        assessed,
        successful: successful.length,
        rateLimited,
        healthPercent: websiteHealth.score,
        availabilityPercent: websiteHealth.availability.score,
        contentPercent: websiteHealth.contentIntegrity.score,
        performancePercent: websiteHealth.performance.score,
        browserPercent: websiteHealth.browserCompatibility.score,
        averageLoadMs: roundedAverage(times),
      };
    });
}
