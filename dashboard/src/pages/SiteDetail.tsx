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
  healthFromChecks,
  healthLabel,
  healthReasons,
  incidentDetailPlain,
  incidentTypeLabel,
  profileLabel,
} from '../lib/labelMappers';
import { formatPakistanTime, formatRelativeTime, sinceDays, TIME_LABEL } from '../lib/time';
import type { FormTest, Incident, LoadCheck, Site } from '../lib/types';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'speed', label: 'Speed' },
  { id: 'forms', label: 'Forms' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'timeline', label: 'Timeline' },
];

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
  const [formQuery, setFormQuery] = useState('');
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
      if (formFilter === 'pass' && !formTestPassed(f)) return false;
      if (formFilter === 'fail' && formTestPassed(f)) return false;
      if (q && !`${f.run_id} ${f.notes || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [formTests, formFilter, formQuery]);

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
                  <li key={c.id}>
                    <strong>{profileLabel(c.profile)}</strong>
                    <span>{c.load_ms ?? '—'}ms</span>
                    <span className="meta">{formatRelativeTime(c.checked_at)}</span>
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
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Run ID</th>
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
                    <td>
                      <span className={`badge ${formTestPassed(f) ? 'ok' : f.layer1_pass === false ? 'bad' : 'muted'}`}>
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
