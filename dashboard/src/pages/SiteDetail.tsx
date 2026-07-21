import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { TabBar } from '../components/TabBar';
import { SiteCharts } from '../components/SiteCharts';
import { Timeline } from '../components/Timeline';
import { ScreenshotModal, ScreenshotThumb } from '../components/ScreenshotModal';
import { supabase } from '../lib/supabase';
import {
  detectionStatusLabel,
  formTestPassed,
  formTestSummary,
  formatRunLocation,
  healthFromChecks,
  healthLabel,
  healthReasons,
  incidentDetailPlain,
  incidentTypeLabel,
  profileLabel,
} from '../lib/labelMappers';
import { isRateLimitedFormTest } from '../lib/healthScoring';
import { formatPakistanTime, formatRelativeTime, sinceDays, TIME_LABEL } from '../lib/time';
import type { FormTest, Incident, LoadCheck, Site } from '../lib/types';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'visits', label: 'Visits' },
  { id: 'speed', label: 'Speed' },
  { id: 'forms', label: 'Forms' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'timeline', label: 'Timeline' },
];

function loadCheckResultLabel(c: LoadCheck): string {
  if (c.status_code === 429) {
    return `Rate limited (HTTP ${c.status_code})`;
  }
  if (!c.loaded || (c.status_code ?? 0) >= 400) {
    return `Failed (${c.status_code ?? 'no status'})`;
  }
  const slow = (c.load_ms ?? 0) > 8000;
  return slow ? `Slow · ${c.load_ms}ms` : `OK · ${c.load_ms ?? '?'}ms`;
}

function loadCheckBadge(c: LoadCheck): 'ok' | 'bad' | 'muted' {
  if (c.status_code === 429) return 'muted';
  if (!c.loaded || (c.status_code ?? 0) >= 400) return 'bad';
  if ((c.load_ms ?? 0) > 8000 || c.elements_ok?.cta === false || c.elements_ok?.quote_form === false) {
    return 'muted';
  }
  return 'ok';
}

export function SiteDetail() {
  const { siteId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overview';

  const [site, setSite] = useState<Site | null>(null);
  const [checks, setChecks] = useState<LoadCheck[]>([]);
  const [formTests, setFormTests] = useState<FormTest[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [chartRange, setChartRange] = useState<'24h' | '7d'>('24h');
  const [formFilter, setFormFilter] = useState<'all' | 'pass' | 'fail'>('all');
  const [formRateLimitedOnly, setFormRateLimitedOnly] = useState(false);
  const [formQuery, setFormQuery] = useState('');
  const [visitProfile, setVisitProfile] = useState<'all' | string>('all');
  const [visitFilter, setVisitFilter] = useState<'all' | 'ok' | 'fail' | 'slow'>('all');
  const [visitRateLimitedOnly, setVisitRateLimitedOnly] = useState(false);
  const [showClosedIncidents, setShowClosedIncidents] = useState(false);
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;

    async function load() {
      const since = sinceDays(30);
      const [{ data: siteRow, error: sErr }, { data: checkRows }, { data: formRows }, { data: incRows }] =
        await Promise.all([
          supabase.from('sites').select('*').eq('id', siteId).maybeSingle(),
          supabase
            .from('load_checks')
            .select('*')
            .eq('site_id', siteId)
            .gte('checked_at', since)
            .order('checked_at', { ascending: false })
            .limit(200),
          supabase
            .from('form_tests')
            .select('*')
            .eq('site_id', siteId)
            .order('tested_at', { ascending: false })
            .limit(100),
          supabase
            .from('incidents')
            .select('*')
            .eq('site_id', siteId)
            .order('opened_at', { ascending: false })
            .limit(100),
        ]);

      if (cancelled) return;
      if (sErr || !siteRow) {
        setError(sErr?.message || 'Site not found');
        return;
      }
      setSite(siteRow as Site);
      setChecks((checkRows || []) as LoadCheck[]);
      setFormTests((formRows || []) as FormTest[]);
      setIncidents((incRows || []) as Incident[]);
      setError(null);
    }

    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [siteId]);

  const health = site?.active ? healthFromChecks(checks) : 'gray';
  const reasons = healthReasons(checks);
  const latestForm = formTests[0] ?? null;
  const openIncidents = incidents.filter((i) => !i.closed_at);
  const closedIncidents = incidents.filter((i) => i.closed_at);

  const chartChecks = useMemo(() => {
    const since =
      chartRange === '24h' ? sinceDays(1) : sinceDays(7);
    return checks
      .filter((c) => c.checked_at >= since)
      .sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  }, [checks, chartRange]);

  const filteredForms = useMemo(() => {
    const q = formQuery.trim().toLowerCase();
    return formTests.filter((f) => {
      const rateLimited = isRateLimitedFormTest(f);
      if (formRateLimitedOnly ? !rateLimited : rateLimited) return false;
      if (formFilter === 'pass' && (rateLimited || !formTestPassed(f))) return false;
      if (formFilter === 'fail' && (rateLimited || formTestPassed(f))) return false;
      if (q && !`${f.run_id} ${f.notes || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [formTests, formFilter, formQuery, formRateLimitedOnly]);

  const filteredVisits = useMemo(() => {
    return checks.filter((c) => {
      if (visitProfile !== 'all' && c.profile !== visitProfile) return false;
      if (visitRateLimitedOnly ? c.status_code !== 429 : c.status_code === 429) return false;
      const badge = loadCheckBadge(c);
      if (visitFilter === 'ok' && badge !== 'ok') return false;
      if (visitFilter === 'fail' && badge !== 'bad') return false;
      if (visitFilter === 'slow' && !((c.load_ms ?? 0) > 8000 && c.loaded)) return false;
      return true;
    });
  }, [checks, visitProfile, visitFilter, visitRateLimitedOnly]);

  function setTab(id: string) {
    setParams({ tab: id });
  }

  function openShot(src: string, alt: string) {
    setModal({ src, alt });
  }

  if (error) {
    return (
      <div>
        <p className="error">{error}</p>
        <Link to="/">← Back to overview</Link>
      </div>
    );
  }

  if (!site) {
    return <p className="empty">Loading site…</p>;
  }

  return (
    <div>
      <div className="page-head site-head">
        <div>
          <Link className="subtle-link" to="/">
            ← Overview
          </Link>
          <h1>{site.name}</h1>
          <p>
            <a href={site.main_url} target="_blank" rel="noreferrer">
              {site.main_url}
            </a>
          </p>
        </div>
        <div className={`health-pill health-${health}`}>
          <span className={`dot ${health}`} />
          {healthLabel(health)}
        </div>
      </div>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="detail-grid">
          <section className="detail-panel">
            <h2>Current status</h2>
            <ul className="reason-list">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="meta">
              {site.active ? 'Monitoring active' : 'Site paused'} · {detectionStatusLabel(site)}
            </p>
          </section>

          <section className="detail-panel">
            <h2>Latest load checks</h2>
            {checks.length === 0 ? (
              <p className="empty">No load checks yet.</p>
            ) : (
              <ul className="metric-list">
                {[...new Map(checks.map((c) => [c.profile, c])).values()].map((c) => (
                  <li key={c.id} className="metric-with-shot">
                    <div>
                      <strong>{profileLabel(c.profile)}</strong>
                      <span>{c.load_ms ?? '—'}ms</span>
                      <span className="meta">{formatRelativeTime(c.checked_at)}</span>
                      <span className="meta run-location">{formatRunLocation(c)}</span>
                    </div>
                    <ScreenshotThumb
                      src={c.screenshot_path}
                      alt={`${profileLabel(c.profile)} load check`}
                      onOpen={(src) => openShot(src, `${profileLabel(c.profile)} load check`)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="detail-panel">
            <h2>Latest form test</h2>
            {!latestForm ? (
              <p className="empty">No form tests yet.</p>
            ) : (
              <>
                <p>{formTestSummary(latestForm)}</p>
                <p className="meta">
                  {formatRelativeTime(latestForm.tested_at)} · {latestForm.run_id}
                </p>
                <p className="run-location">Accessed from: {formatRunLocation(latestForm)}</p>
                {latestForm.notes && <p className="notes-block">{latestForm.notes}</p>}
                <ScreenshotThumb
                  src={latestForm.screenshot_path}
                  alt={`Form test ${latestForm.run_id}`}
                  onOpen={(src) => openShot(src, `Form test ${latestForm.run_id}`)}
                />
              </>
            )}
          </section>

          {openIncidents.length > 0 && (
            <section className="detail-panel alert-panel">
              <h2>Open incidents ({openIncidents.length})</h2>
              {openIncidents.map((i) => (
                <article key={i.id} className="mini-incident">
                  <strong>{incidentTypeLabel(i.type)}</strong>
                  <p>{incidentDetailPlain(i)}</p>
                </article>
              ))}
            </section>
          )}
        </div>
      )}

      {tab === 'speed' && (
        <SiteCharts checks={chartChecks} range={chartRange} onRangeChange={setChartRange} />
      )}

      {tab === 'visits' && (
        <div>
          <p className="section-hint">
            Every website load check (Desktop, Safari, Mobile) with screenshot Preview when captured.
          </p>
          <div className="filter-bar">
            <label>
              Browser
              <select
                value={visitProfile}
                onChange={(e) => setVisitProfile(e.target.value)}
              >
                <option value="all">All</option>
                <option value="desktop">Desktop</option>
                <option value="webkit">Safari</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
            <label>
              Result
              <select
                value={visitFilter}
                onChange={(e) =>
                  setVisitFilter(e.target.value as 'all' | 'ok' | 'fail' | 'slow')
                }
              >
                <option value="all">All</option>
                <option value="ok">Healthy</option>
                <option value="slow">Slow</option>
                <option value="fail">Failed</option>
              </select>
            </label>
            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={visitRateLimitedOnly}
                onChange={(e) => {
                  setVisitRateLimitedOnly(e.target.checked);
                  if (e.target.checked) setVisitFilter('all');
                }}
              />
              Rate limited only
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Browser</th>
                  <th>Accessed from</th>
                  <th>Result</th>
                  <th>Notes</th>
                  <th>Screenshot</th>
                </tr>
              </thead>
              <tbody>
                {filteredVisits.map((c) => {
                  const title = `${profileLabel(c.profile)} · ${formatPakistanTime(c.checked_at)}`;
                  return (
                    <tr key={c.id}>
                      <td>
                        {formatRelativeTime(c.checked_at)}
                        <div className="meta">
                          {formatPakistanTime(c.checked_at)} {TIME_LABEL}
                        </div>
                      </td>
                      <td>{profileLabel(c.profile)}</td>
                      <td className="notes-cell">{formatRunLocation(c)}</td>
                      <td>
                        <span className={`badge ${loadCheckBadge(c)}`}>
                          {loadCheckResultLabel(c)}
                        </span>
                      </td>
                      <td className="notes-cell">{c.notes || '—'}</td>
                      <td>
                        <ScreenshotThumb
                          src={c.screenshot_path}
                          alt={title}
                          onOpen={(src) => openShot(src, title)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredVisits.length === 0 && <p className="empty">No load checks match.</p>}
        </div>
      )}

      {tab === 'forms' && (
        <div>
          <div className="filter-bar">
            <label>
              Search
              <input
                value={formQuery}
                onChange={(e) => setFormQuery(e.target.value)}
                placeholder="Run ID or notes…"
              />
            </label>
            <label>
              Result
              <select
                value={formFilter}
                onChange={(e) => setFormFilter(e.target.value as 'all' | 'pass' | 'fail')}
              >
                <option value="all">All</option>
                <option value="pass">Passed</option>
                <option value="fail">Failed</option>
              </select>
            </label>
            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={formRateLimitedOnly}
                onChange={(e) => {
                  setFormRateLimitedOnly(e.target.checked);
                  if (e.target.checked) setFormFilter('all');
                }}
              />
              Rate limited only
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Run ID</th>
                  <th>Accessed from</th>
                  <th>Result</th>
                  <th>Notes</th>
                  <th>Screenshot</th>
                </tr>
              </thead>
              <tbody>
                {filteredForms.map((f) => (
                  <tr key={f.id}>
                    <td>
                      {formatRelativeTime(f.tested_at)}
                      <div className="meta">{formatPakistanTime(f.tested_at)} {TIME_LABEL}</div>
                    </td>
                    <td>
                      <code>{f.run_id}</code>
                    </td>
                    <td className="notes-cell">{formatRunLocation(f)}</td>
                    <td>
                      <span
                        className={`badge ${
                          isRateLimitedFormTest(f)
                            ? 'muted'
                            : formTestPassed(f)
                              ? 'ok'
                              : f.layer1_pass === false
                                ? 'bad'
                                : 'muted'
                        }`}
                      >
                        {formTestSummary(f)}
                      </span>
                    </td>
                    <td className="notes-cell">{f.notes || '—'}</td>
                    <td>
                      <ScreenshotThumb
                        src={f.screenshot_path}
                        alt={f.run_id}
                        onOpen={(src) => openShot(src, f.run_id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredForms.length === 0 && <p className="empty">No form tests match.</p>}
        </div>
      )}

      {tab === 'incidents' && (
        <div className="incident-queue">
          <h2>Open ({openIncidents.length})</h2>
          {openIncidents.length === 0 ? (
            <p className="empty">No open incidents — good sign.</p>
          ) : (
            openIncidents.map((i) => (
              <article key={i.id} className="incident open">
                <header>
                  <strong>{incidentTypeLabel(i.type)}</strong>
                  <span className="badge bad">Open</span>
                </header>
                <p>{incidentDetailPlain(i)}</p>
                <p className="meta">Opened {formatPakistanTime(i.opened_at)} {TIME_LABEL}</p>
                <ScreenshotThumb
                  src={i.screenshot_path}
                  alt={incidentTypeLabel(i.type)}
                  onOpen={(src) => openShot(src, incidentTypeLabel(i.type))}
                />
              </article>
            ))
          )}

          <button
            type="button"
            className="linkish advanced-toggle"
            onClick={() => setShowClosedIncidents((v) => !v)}
          >
            {showClosedIncidents ? 'Hide' : 'Show'} closed incidents ({closedIncidents.length})
          </button>

          {showClosedIncidents &&
            closedIncidents.map((i) => (
              <article key={i.id} className="incident closed">
                <header>
                  <strong>{incidentTypeLabel(i.type)}</strong>
                  <span className="badge muted">Closed</span>
                </header>
                <p>{incidentDetailPlain(i)}</p>
                <p className="meta">
                  Opened {formatPakistanTime(i.opened_at)} · Closed {formatPakistanTime(i.closed_at)}
                </p>
                <ScreenshotThumb
                  src={i.screenshot_path}
                  alt={incidentTypeLabel(i.type)}
                  onOpen={(src) => openShot(src, incidentTypeLabel(i.type))}
                />
              </article>
            ))}
        </div>
      )}

      {tab === 'timeline' && (
        <Timeline
          loadChecks={checks}
          formTests={formTests}
          incidents={incidents}
          onOpenScreenshot={openShot}
        />
      )}

      <ScreenshotModal
        src={modal?.src ?? null}
        alt={modal?.alt}
        onClose={() => setModal(null)}
      />
    </div>
  );
}
