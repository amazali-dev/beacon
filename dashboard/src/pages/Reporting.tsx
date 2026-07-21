import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ScreenshotModal, ScreenshotThumb } from '../components/ScreenshotModal';
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
  if (value >= 99) return 'green';
  if (value >= 90) return 'yellow';
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
        label="Visit health"
        value={percent(metrics.healthPercent)}
        detail={`${metrics.successfulVisits.toLocaleString()} successful of ${(metrics.successfulVisits + metrics.failedVisits).toLocaleString()} assessed · rate limits excluded`}
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
        label="Form success"
        value={percent(metrics.formSuccessPercent)}
        detail={`${metrics.successfulForms} submitted of ${decidedForms} completed attempts · ${metrics.skippedForms} skipped`}
        tone={healthTone(metrics.formSuccessPercent)}
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

      <p className="report-formula">
        <strong>Visit health</strong> = successful HTTP 2xx/3xx visits ÷ assessed visits.
        A first successful run shows 100%. HTTP 429/503 rate limits are shown separately and
        excluded because they reflect the GitHub monitor IP, not confirmed website downtime.
      </p>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <div className="report-loading">
          <span className="report-loader" />
          <p>Building exact report across all history pages…</p>
        </div>
      ) : (
        <>
          <ReportMetricsGrid metrics={metrics} />

          <section className="report-panel">
            <div className="report-section-head">
              <div>
                <span className="eyebrow">Trend</span>
                <h2>Daily health history</h2>
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
