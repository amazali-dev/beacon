import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { calculateReportMetrics, loadReportData, type ReportData, type ReportRangeDays } from '../lib/reporting';
import { TIME_LABEL } from '../lib/time';
import { HealthBreakdown } from './Reporting';

const VALID_DAYS = new Set([1, 3, 7, 15, 30]);

export function HealthMethodology() {
  const [params] = useSearchParams();
  const selectedSiteId = params.get('site') || '';
  const parsedDays = Number(params.get('days') || 7);
  const days = (VALID_DAYS.has(parsedDays) ? parsedDays : 7) as ReportRangeDays;
  const [data, setData] = useState<ReportData>({ sites: [], checks: [], forms: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          setError(err instanceof Error ? err.message : 'Could not load health calculation');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [days, selectedSiteId]);

  const selectedSite = selectedSiteId
    ? data.sites.find((site) => site.id === selectedSiteId)
    : null;
  const metrics = useMemo(
    () => calculateReportMetrics(data.checks, data.forms),
    [data.checks, data.forms]
  );
  const backHref = `/reports?days=${days}${
    selectedSiteId ? `&site=${encodeURIComponent(selectedSiteId)}` : ''
  }`;

  return (
    <div className="report-page methodology-page">
      <header className="methodology-hero">
        <div>
          <span className="eyebrow">Scoring reference</span>
          <h1>How health is calculated</h1>
          <p>
            Complete scoring parameters and the live breakdown for{' '}
            <strong>{selectedSite?.name || 'all websites'}</strong> over the rolling{' '}
            {days === 1 ? '24 hours' : `${days} days`}.
          </p>
        </div>
        <div className="methodology-actions">
          <span>Production only · {TIME_LABEL}</span>
          <Link className="button-link" to={backHref}>
            ← Back to report
          </Link>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <div className="report-loading">
          <span className="report-loader" />
          <p>Calculating the live score breakdown…</p>
        </div>
      ) : (
        <HealthBreakdown metrics={metrics} methodologyOpen />
      )}
    </div>
  );
}
