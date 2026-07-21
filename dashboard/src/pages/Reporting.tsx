import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ScreenshotModal, ScreenshotThumb } from '../components/ScreenshotModal';
import {
  HEALTH_SCORING_CONFIG,
  type ScoreComponent,
} from '../lib/healthScoring';
import {
  buildDailyHistory,
  calculateReportMetrics,
  hasContentIssue,
  isRateLimitedForm,
  isRateLimitedVisit,
  isSuccessfulVisit,
  loadReportData,
  type ReportData,
  type ReportMetrics,
  type ReportRangeDays,
} from '../lib/reporting';
import {
  formatRunLocation,
  formTestSummary,
  profileLabel,
} from '../lib/labelMappers';
import {
  formatPakistanTime,
  formatRelativeTime,
  TIME_LABEL,
} from '../lib/time';
import type { FormTest, LoadCheck } from '../lib/types';

const RANGES: Array<{ days: ReportRangeDays; label: string }> = [
  { days: 1, label: 'Daily' },
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days' },
  { days: 15, label: '15 days' },
  { days: 30, label: '30 days' },
];

const EVIDENCE_PAGE_SIZE = 18;

function percent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(value % 1 ? 1 : 0)}%`;
}

function duration(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value}ms`;
}

function healthTone(value: number | null): 'green' | 'yellow' | 'red' | 'gray' {
  if (value === null) return 'gray';
  if (value >= HEALTH_SCORING_CONFIG.healthThresholds.healthyMin) return 'green';
  if (value >= HEALTH_SCORING_CONFIG.healthThresholds.attentionMin) return 'yellow';
  return 'red';
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'green' | 'yellow' | 'red' | 'gray';
}) {
  return (
    <article className={`report-metric ${tone ? `tone-${tone}` : ''}`}>
      <span className="report-metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function ReportMetricsGrid({ metrics }: { metrics: ReportMetrics }) {
  const decidedForms = metrics.successfulForms + metrics.failedForms;

  return (
    <section className="report-metrics" aria-label="Report summary">
      <MetricCard
        label="Overall health"
        value={percent(metrics.healthPercent)}
        detail="Weighted availability, content, performance and browser score"
        tone={healthTone(metrics.healthPercent)}
      />
      <MetricCard
        label="Total visits"
        value={metrics.totalVisits.toLocaleString()}
        detail={`${metrics.failedVisits.toLocaleString()} unsuccessful · ${metrics.rateLimitedVisits.toLocaleString()} rate-limited`}
      />
      <MetricCard
        label="Average load"
        value={duration(metrics.averageLoadMs)}
        detail={`P95 ${duration(metrics.p95LoadMs)} · fastest ${duration(metrics.fastestLoadMs)}`}
        tone={
          metrics.averageLoadMs === null
            ? 'gray'
            : metrics.averageLoadMs <= 4000
              ? 'green'
              : metrics.averageLoadMs <= 8000
                ? 'yellow'
                : 'red'
        }
      />
      <MetricCard
        label="Form health"
        value={percent(metrics.formHealthPercent)}
        detail={`${metrics.successfulForms} submitted of ${decidedForms} completed attempts · ${metrics.skippedForms} skipped`}
        tone={healthTone(metrics.formHealthPercent)}
      />
      <MetricCard
        label="Slow visits"
        value={metrics.slowVisits.toLocaleString()}
        detail="Successful visits slower than 8 seconds"
        tone={metrics.slowVisits === 0 ? 'green' : 'yellow'}
      />
      <MetricCard
        label="Content checks"
        value={metrics.contentIssueVisits.toLocaleString()}
        detail="Visits where a required CTA or form was not found"
        tone={metrics.contentIssueVisits === 0 ? 'green' : 'yellow'}
      />
      <MetricCard
        label="Monitor confidence"
        value={percent(metrics.monitorConfidencePercent)}
        detail={`${metrics.websiteHealth.confidenceLabel} confidence · ${metrics.websiteHealth.observedProfiles}/${metrics.websiteHealth.expectedProfiles} browsers assessed`}
        tone={
          metrics.websiteHealth.confidenceLabel === 'High'
            ? 'green'
            : metrics.websiteHealth.confidenceLabel === 'Moderate'
              ? 'yellow'
              : metrics.websiteHealth.confidenceLabel === 'Low'
                ? 'red'
                : 'gray'
        }
      />
    </section>
  );
}

function ScoreRow({ component }: { component: ScoreComponent }) {
  return (
    <div className="score-row">
      <div className="score-row-copy">
        <strong>{component.label}</strong>
        <small>{component.detail}</small>
      </div>
      <span className="score-weight">{component.weight}% weight</span>
      <strong className={`score-value tone-${healthTone(component.score)}`}>
        {percent(component.score)}
      </strong>
    </div>
  );
}

export function HealthBreakdown({
  metrics,
  methodologyOpen = false,
}: {
  metrics: ReportMetrics;
  methodologyOpen?: boolean;
}) {
  const website = metrics.websiteHealth;
  const forms = metrics.formHealth;

  return (
    <section className="report-panel health-breakdown">
      <div className="report-section-head">
        <div>
          <span className="eyebrow">Transparent scoring</span>
          <h2>Health score breakdown</h2>
        </div>
        <p>No hidden parameters. Unknown data is shown as “—”, never assumed healthy.</p>
      </div>

      <div className="score-columns">
        <div className="score-column">
          <header>
            <div>
              <strong>Website health</strong>
              <small>Composite score: {percent(website.score)}</small>
            </div>
            <span className={`confidence-pill confidence-${website.confidenceLabel.toLowerCase().replace(' ', '-')}`}>
              {website.confidenceLabel} confidence
            </span>
          </header>
          <ScoreRow component={website.availability} />
          <ScoreRow component={website.contentIntegrity} />
          <ScoreRow component={website.performance} />
          <ScoreRow component={website.browserCompatibility} />
          <p className="score-footnote">
            {website.excludedRateLimits} HTTP 429 visit
            {website.excludedRateLimits === 1 ? '' : 's'} excluded from health. HTTP 503 remains
            a failure because it can indicate real service unavailability.
          </p>
        </div>

        <div className="score-column">
          <header>
            <div>
              <strong>Form health</strong>
              <small>Composite score: {percent(forms.score)}</small>
            </div>
            <span className="confidence-pill">
              {forms.assessedForms} assessed · {forms.skippedForms} skipped
            </span>
          </header>
          <ScoreRow component={forms.contactFields} />
          <ScoreRow component={forms.logoUpload} />
          <ScoreRow component={forms.submissionConfirmation} />
          <ScoreRow component={forms.leadEmail} />
          <p className="score-footnote">
            Lead email is scored only when inbox verification produced a result. Rate-limited
            form runs are skipped, not failed.
          </p>
        </div>
      </div>

      <details className="health-methodology" open={methodologyOpen}>
        <summary>
          <span aria-hidden>ⓘ</span> How health is calculated
        </summary>
        <div className="methodology-body">
          <section>
            <h3>Website formula</h3>
            <p>
              Overall health is the weighted average of Availability{' '}
              <strong>{HEALTH_SCORING_CONFIG.websiteWeights.availability}%</strong>, Critical
              content <strong>{HEALTH_SCORING_CONFIG.websiteWeights.contentIntegrity}%</strong>,
              Performance <strong>{HEALTH_SCORING_CONFIG.websiteWeights.performance}%</strong>,
              and Browser compatibility{' '}
              <strong>{HEALTH_SCORING_CONFIG.websiteWeights.browserCompatibility}%</strong>.
              If a component has no measurable data, it is marked unknown and the available
              weights are normalized rather than inventing a pass or failure.
            </p>
          </section>
          <section>
            <h3>Parameter definitions</h3>
            <ul>
              <li>
                <strong>Availability:</strong> HTTP 2xx/3xx and loaded successfully, divided by
                assessed visits. Timeouts, network failures, 4xx and 5xx count as failures.
              </li>
              <li>
                <strong>Critical content:</strong> logo, headline, quote CTA and expected quote
                form assertions on successful visits.
              </li>
              <li>
                <strong>Performance:</strong> ≤
                {HEALTH_SCORING_CONFIG.performance.fastMaxMs / 1000}s scores{' '}
                {HEALTH_SCORING_CONFIG.performance.fastScore}; ≤
                {HEALTH_SCORING_CONFIG.performance.acceptableMaxMs / 1000}s scores{' '}
                {HEALTH_SCORING_CONFIG.performance.acceptableScore}; slower scores{' '}
                {HEALTH_SCORING_CONFIG.performance.slowScore}. Average and P95 are also shown
                separately.
              </li>
              <li>
                <strong>Browser compatibility:</strong> availability balanced across Desktop,
                Safari and Mobile profiles that produced assessable results.
              </li>
            </ul>
          </section>
          <section>
            <h3>Rate limits and confidence</h3>
            <p>
              A definite HTTP 429 is excluded because it shows the GitHub monitor IP was blocked,
              not confirmed website downtime. HTTP 503 is not automatically excluded. Confidence
              combines assessable-visit coverage (70%) and browser-profile coverage (30%). A high
              score with low confidence must not be interpreted as conclusive health.
            </p>
          </section>
          <section>
            <h3>Form formula</h3>
            <p>
              Form health combines contact fields{' '}
              <strong>{HEALTH_SCORING_CONFIG.formWeights.contactFields}%</strong>, logo upload{' '}
              <strong>{HEALTH_SCORING_CONFIG.formWeights.logoUpload}%</strong>, submission
              confirmation{' '}
              <strong>{HEALTH_SCORING_CONFIG.formWeights.submissionConfirmation}%</strong>, and
              lead email <strong>{HEALTH_SCORING_CONFIG.formWeights.leadEmail}%</strong>. Optional
              email verification is omitted when disabled, and remaining measured weights are
              normalized.
            </p>
          </section>
          <section>
            <h3>Labels and scope</h3>
            <p>
              Healthy is ≥{HEALTH_SCORING_CONFIG.healthThresholds.healthyMin}%; Needs attention is
              ≥{HEALTH_SCORING_CONFIG.healthThresholds.attentionMin}%; lower is Unhealthy. Reports
              use production rows only and rolling 24-hour/3/7/15/30-day windows in PKT. These
              centrally defined weights and thresholds can be changed later without rewriting the
              report.
            </p>
          </section>
        </div>
      </details>
    </section>
  );
}

type Evidence =
  | { kind: 'visit'; timestamp: string; row: LoadCheck }
  | { kind: 'form'; timestamp: string; row: FormTest };

export function Reporting() {
  const [params, setParams] = useSearchParams();
  const selectedSiteId = params.get('site') || '';
  const parsedDays = Number(params.get('days') || 7);
  const days: ReportRangeDays = RANGES.some((range) => range.days === parsedDays)
    ? (parsedDays as ReportRangeDays)
    : 7;

  const [data, setData] = useState<ReportData>({ sites: [], checks: [], forms: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evidenceType, setEvidenceType] = useState<'all' | 'visit' | 'form'>('all');
  const [evidencePage, setEvidencePage] = useState(1);
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void loadReportData(days, selectedSiteId || undefined)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not build report');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [days, selectedSiteId]);

  useEffect(() => {
    setEvidencePage(1);
  }, [days, selectedSiteId, evidenceType]);

  const siteById = useMemo(
    () => new Map(data.sites.map((site) => [site.id, site])),
    [data.sites]
  );
  const selectedSite = selectedSiteId ? siteById.get(selectedSiteId) : null;
  const metrics = useMemo(
    () => calculateReportMetrics(data.checks, data.forms),
    [data.checks, data.forms]
  );
  const history = useMemo(() => buildDailyHistory(data.checks), [data.checks]);

  const siteReports = useMemo(
    () =>
      data.sites.map((site) => ({
        site,
        metrics: calculateReportMetrics(
          data.checks.filter((check) => check.site_id === site.id),
          data.forms.filter((form) => form.site_id === site.id)
        ),
      })),
    [data]
  );

  const evidence = useMemo(() => {
    const rows: Evidence[] = [
      ...data.checks.map(
        (row): Evidence => ({ kind: 'visit', timestamp: row.checked_at, row })
      ),
      ...data.forms.map(
        (row): Evidence => ({ kind: 'form', timestamp: row.tested_at, row })
      ),
    ];
    return rows
      .filter((item) => evidenceType === 'all' || item.kind === evidenceType)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [data.checks, data.forms, evidenceType]);

  const evidencePages = Math.max(1, Math.ceil(evidence.length / EVIDENCE_PAGE_SIZE));
  const visibleEvidence = evidence.slice(
    (evidencePage - 1) * EVIDENCE_PAGE_SIZE,
    evidencePage * EVIDENCE_PAGE_SIZE
  );

  function setDays(nextDays: ReportRangeDays) {
    const next = new URLSearchParams(params);
    next.set('days', String(nextDays));
    setParams(next);
  }

  function showCollective() {
    const next = new URLSearchParams(params);
    next.delete('site');
    setParams(next);
  }

  function selectSite(siteId: string) {
    const next = new URLSearchParams(params);
    if (siteId) next.set('site', siteId);
    else next.delete('site');
    setParams(next);
  }

  return (
    <div className="report-page">
      <header className="report-hero">
        <div>
          <span className="eyebrow">Operational intelligence</span>
          <h1>{selectedSite ? selectedSite.name : 'Collective report'}</h1>
          <p>
            {selectedSite
              ? `Detailed production history for ${selectedSite.name}.`
              : 'All monitored sites, combined into one production health report.'}
          </p>
        </div>
        <Link
          className="report-method-link"
          to={`/reports/methodology?days=${days}${selectedSiteId ? `&site=${encodeURIComponent(selectedSiteId)}` : ''}`}
        >
          <span aria-hidden>ⓘ</span>
          How health is calculated
          <b aria-hidden>→</b>
        </Link>
        <div className="report-hero-meta">
          <span>Rolling {days === 1 ? '24 hours' : `${days} days`}</span>
          <span>Times in {TIME_LABEL}</span>
          <span>Production runs only</span>
        </div>
      </header>

      <div className="report-toolbar">
        <div className="range-switcher" aria-label="Report history range">
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              className={days === range.days ? 'active' : ''}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </button>
          ))}
        </div>
        <label className="report-site-selector">
          <span>Website</span>
          <select
            value={selectedSiteId}
            onChange={(event) => selectSite(event.target.value)}
            aria-label="Select website report"
          >
            <option value="">All websites — collective</option>
            {data.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedSiteId && (
        <button type="button" className="report-back report-back-inline" onClick={showCollective}>
          ← Back to collective report
        </button>
      )}

      {error && <p className="error">{error}</p>}
      {loading ? (
        <div className="report-loading">
          <span className="report-loader" />
          <p>Building exact report across all history pages…</p>
        </div>
      ) : (
        <>
          {!selectedSiteId && (
            <section className="report-panel">
              <div className="report-section-head">
                <div>
                  <span className="eyebrow">Portfolio</span>
                  <h2>Website reports</h2>
                </div>
                <p>Select a website for its detailed report and evidence.</p>
              </div>
              <div className="report-site-grid">
                {siteReports.map(({ site, metrics: siteMetrics }, index) => (
                  <Link
                    key={site.id}
                    to={`/reports?days=${days}&site=${site.id}`}
                    className="report-site-card"
                  >
                    <span className="report-site-number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div>
                      <strong>{site.name}</strong>
                      <small>{siteMetrics.totalVisits.toLocaleString()} visits</small>
                    </div>
                    <div className={`report-site-score tone-${healthTone(siteMetrics.healthPercent)}`}>
                      {percent(siteMetrics.healthPercent)}
                    </div>
                    <span className="report-site-arrow">→</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <ReportMetricsGrid metrics={metrics} />

          <section className="report-panel">
            <div className="report-section-head">
              <div>
                <span className="eyebrow">Trend</span>
                <h2>Daily overall health history</h2>
              </div>
              <p>Each column summarizes all browser visits recorded that day.</p>
            </div>
            {history.length ? (
              <div className="health-history">
                {history.map((point) => (
                  <article key={point.key} className="health-day">
                    <div className="health-day-value">
                      <strong>{percent(point.healthPercent)}</strong>
                      <span>{point.successful}/{point.assessed} assessed</span>
                    </div>
                    <div className="health-bar-track">
                      <span
                        className={`health-bar-fill tone-${healthTone(point.healthPercent)}`}
                        style={{ height: `${Math.max(4, point.healthPercent || 0)}%` }}
                      />
                    </div>
                    <span className="health-day-label">{point.label}</span>
                    <small>{duration(point.averageLoadMs)} avg</small>
                    {point.rateLimited > 0 && (
                      <small className="rate-note">{point.rateLimited} limited</small>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="empty">No production visits in this range.</p>
            )}
          </section>

          <section className="report-panel report-evidence-panel">
            <div className="report-section-head">
              <div>
                <span className="eyebrow">Evidence</span>
                <h2>Visits &amp; form submissions</h2>
              </div>
              <p>{evidence.length.toLocaleString()} records in this report.</p>
            </div>

            <div className="evidence-switcher">
              {(['all', 'visit', 'form'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={evidenceType === kind ? 'active' : ''}
                  onClick={() => setEvidenceType(kind)}
                >
                  {kind === 'all' ? 'All evidence' : kind === 'visit' ? 'Website visits' : 'Forms'}
                </button>
              ))}
            </div>

            <div className="evidence-list">
              {visibleEvidence.map((item) => {
                const site = siteById.get(item.row.site_id);
                if (item.kind === 'visit') {
                  const check = item.row;
                  const success = isSuccessfulVisit(check);
                  const limited = isRateLimitedVisit(check);
                  const title = `${site?.name || 'Site'} · ${profileLabel(check.profile)}`;
                  return (
                    <article key={`visit-${check.id}`} className="evidence-row">
                      <div className={`evidence-kind ${success ? 'ok' : limited ? 'limited' : 'bad'}`}>
                        VISIT
                      </div>
                      <div className="evidence-main">
                        <header>
                          <strong>{title}</strong>
                          <span className={`badge ${success ? 'ok' : limited ? 'muted' : 'bad'}`}>
                            {success
                              ? `Successful · ${duration(check.load_ms)}`
                              : limited
                                ? `Rate limited · HTTP ${check.status_code}`
                                : `Failed · ${check.status_code ?? 'no status'}`}
                          </span>
                        </header>
                        <p className="meta">
                          {formatRelativeTime(check.checked_at)} ·{' '}
                          {formatPakistanTime(check.checked_at)} {TIME_LABEL}
                        </p>
                        <p className="run-location">{formatRunLocation(check)}</p>
                        <p className="evidence-notes">
                          {hasContentIssue(check)
                            ? 'Required CTA or form was not found.'
                            : check.notes || 'No additional notes.'}
                        </p>
                      </div>
                      <ScreenshotThumb
                        src={check.screenshot_path}
                        alt={title}
                        onOpen={(src) => setModal({ src, alt: title })}
                      />
                    </article>
                  );
                }

                const form = item.row;
                const limited = isRateLimitedForm(form);
                const title = `${site?.name || 'Site'} · ${form.run_id}`;
                return (
                  <article key={`form-${form.id}`} className="evidence-row">
                    <div
                      className={`evidence-kind ${
                        form.layer1_pass === true ? 'ok' : limited ? 'limited' : 'bad'
                      }`}
                    >
                      FORM
                    </div>
                    <div className="evidence-main">
                      <header>
                        <strong>{title}</strong>
                        <span
                          className={`badge ${
                            form.layer1_pass === true ? 'ok' : limited ? 'muted' : 'bad'
                          }`}
                        >
                          {formTestSummary(form)}
                        </span>
                      </header>
                      <p className="meta">
                        {formatRelativeTime(form.tested_at)} ·{' '}
                        {formatPakistanTime(form.tested_at)} {TIME_LABEL}
                      </p>
                      <p className="run-location">{formatRunLocation(form)}</p>
                      <p className="evidence-notes">{form.notes || 'No additional notes.'}</p>
                    </div>
                    <ScreenshotThumb
                      src={form.screenshot_path}
                      alt={title}
                      onOpen={(src) => setModal({ src, alt: title })}
                    />
                  </article>
                );
              })}
              {!visibleEvidence.length && <p className="empty">No evidence in this range.</p>}
            </div>

            {evidencePages > 1 && (
              <div className="report-pagination">
                <button
                  type="button"
                  disabled={evidencePage === 1}
                  onClick={() => setEvidencePage((page) => Math.max(1, page - 1))}
                >
                  ← Previous
                </button>
                <span>
                  Page {evidencePage} of {evidencePages}
                </span>
                <button
                  type="button"
                  disabled={evidencePage === evidencePages}
                  onClick={() => setEvidencePage((page) => Math.min(evidencePages, page + 1))}
                >
                  Next →
                </button>
              </div>
            )}
          </section>
        </>
      )}

      <ScreenshotModal
        src={modal?.src ?? null}
        alt={modal?.alt}
        onClose={() => setModal(null)}
      />
    </div>
  );
}
