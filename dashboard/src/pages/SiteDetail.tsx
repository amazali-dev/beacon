import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { TabBar } from '../components/TabBar';
import { SiteCharts } from '../components/SiteCharts';
import { Timeline } from '../components/Timeline';
import { ScreenshotModal, ScreenshotThumb, ScreenshotEvidence, collectScreenshotPaths } from '../components/ScreenshotModal';
import { supabase } from '../lib/supabase';
import {
  detectionStatusLabel,
  formTestPassed,
  formatRunLocation,
  healthFromChecks,
  healthLabel,
  healthReasons,
  incidentDetailPlain,
  incidentTypeLabel,
  profileLabel,
} from '../lib/labelMappers';
import {
  brandFromRunId,
  egressFooterText,
  formCardTone,
  formDetectionStatus,
  formFieldsStatus,
  formRunLocationParts,
  formSummaryBadges,
  loadCheckDisplay,
  parseFormNoteMeta,
  splitFormNoteSteps,
} from '../lib/siteDashboard';
import { isRateLimitedFormTest } from '../lib/healthScoring';
import { formatPakistanTime, formatRelativeTime, sinceDays, TIME_LABEL } from '../lib/time';
import type { FormTest, Incident, LoadCheck, Site } from '../lib/types';

const TABS = [
  { id: 'overview', label: 'Dashboard' },
  { id: 'visits', label: 'Visits' },
  { id: 'speed', label: 'Speed' },
  { id: 'forms', label: 'Forms' },
  { id: 'incidents', label: 'Incidents' },
  { id: 'timeline', label: 'Timeline' },
];
const PAGE_SIZE = 1000;

async function fetchSiteChecks(siteId: string, since: string): Promise<LoadCheck[]> {
  const rows: LoadCheck[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('load_checks')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_production', true)
      .gte('checked_at', since)
      .order('checked_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as LoadCheck[]));
    if ((data || []).length < PAGE_SIZE) return rows;
  }
}

async function fetchSiteForms(siteId: string, since: string): Promise<FormTest[]> {
  const rows: FormTest[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('form_tests')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_production', true)
      .gte('tested_at', since)
      .order('tested_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data || []) as FormTest[]));
    if ((data || []).length < PAGE_SIZE) return rows;
  }
}

function loadCheckBadge(c: LoadCheck, slowThresholdMs: number): 'ok' | 'bad' | 'muted' {
  if (c.status_code === 429) return 'muted';
  if (!c.loaded || (c.status_code ?? 0) >= 400) return 'bad';
  if ((c.load_ms ?? 0) > slowThresholdMs || c.elements_ok?.cta === false || c.elements_ok?.quote_form === false) {
    return 'muted';
  }
  return 'ok';
}

function ProfileIcon({ profile }: { profile: string }) {
  const common = { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true as const };
  if (profile === 'mobile') {
    return (
      <svg {...common}>
        <rect x="4" y="1.5" width="8" height="13" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7 12.5h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (profile === 'webkit') {
    return (
      <svg {...common}>
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 13.5h6M8 11.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
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
  const [slowThresholdMs, setSlowThresholdMs] = useState(8000);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dataAsOf, setDataAsOf] = useState<string | null>(null);
  const [formFilter, setFormFilter] = useState<'all' | 'pass' | 'fail'>('all');
  const [formRateLimitedOnly, setFormRateLimitedOnly] = useState(false);
  const [formQuery, setFormQuery] = useState('');
  const [visitProfile, setVisitProfile] = useState<'all' | string>('all');
  const [visitFilter, setVisitFilter] = useState<'all' | 'ok' | 'fail' | 'slow'>('all');
  const [visitRateLimitedOnly, setVisitRateLimitedOnly] = useState(false);
  const [showClosedIncidents, setShowClosedIncidents] = useState(false);
  const [expandedFormIds, setExpandedFormIds] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!siteId) return;
    let cancelled = false;

    async function load() {
      const since = sinceDays(30);
      const [{ data: siteRow, error: sErr }, checkRows, formRows, { data: incRows }, { data: thresholdRow }] =
        await Promise.all([
          supabase.from('sites').select('*').eq('id', siteId).maybeSingle(),
          fetchSiteChecks(siteId, since),
          fetchSiteForms(siteId, since),
          supabase
            .from('incidents')
            .select('*')
            .eq('site_id', siteId)
            .eq('is_production', true)
            .order('opened_at', { ascending: false })
            .limit(500),
          supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'loadTimeThresholdMs')
            .maybeSingle(),
        ]);

      if (cancelled) return;
      if (sErr || !siteRow) {
        setError(sErr?.message || 'Site not found');
        return;
      }
      setSite(siteRow as Site);
      setChecks(checkRows);
      setFormTests(formRows);
      setIncidents((incRows || []) as Incident[]);
      setSlowThresholdMs(Number(thresholdRow?.value) || 8000);
      setDataAsOf(new Date().toISOString());
      setError(null);
    }

    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [siteId, refreshKey]);

  const health = site?.active ? healthFromChecks(checks, slowThresholdMs) : 'gray';
  const reasons = healthReasons(checks, slowThresholdMs);
  const latestForm = formTests[0] ?? null;
  const openIncidents = incidents.filter((i) => !i.closed_at);
  const closedIncidents = incidents.filter((i) => i.closed_at);

  const latestChecksByProfile = useMemo(() => {
    const latest = new Map<string, LoadCheck>();
    for (const check of checks) {
      if (!latest.has(check.profile)) latest.set(check.profile, check);
    }
    return [...latest.values()];
  }, [checks]);

  const chartChecks = useMemo(() => {
    const since = chartRange === '24h' ? sinceDays(1) : sinceDays(7);
    return checks
      .filter((c) => c.checked_at >= since)
      .sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  }, [checks, chartRange]);

  const filteredForms = useMemo(() => {
    const q = formQuery.trim().toLowerCase();
    return formTests.filter((f) => {
      const rateLimited = isRateLimitedFormTest(f);
      const monitorError = f.outcome === 'monitor_error';
      if (formRateLimitedOnly ? !rateLimited : rateLimited) return false;
      if (formFilter === 'pass' && (rateLimited || monitorError || !formTestPassed(f))) return false;
      if (formFilter === 'fail' && (rateLimited || monitorError || formTestPassed(f))) return false;
      if (q && !`${f.run_id} ${f.notes || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [formTests, formFilter, formQuery, formRateLimitedOnly]);

  const filteredVisits = useMemo(() => {
    return checks.filter((c) => {
      if (visitProfile !== 'all' && c.profile !== visitProfile) return false;
      if (visitRateLimitedOnly ? c.status_code !== 429 : c.status_code === 429) return false;
      const badge = loadCheckBadge(c, slowThresholdMs);
      if (visitFilter === 'ok' && badge !== 'ok') return false;
      if (visitFilter === 'fail' && badge !== 'bad') return false;
      if (visitFilter === 'slow' && !((c.load_ms ?? 0) > slowThresholdMs && c.loaded)) return false;
      return true;
    });
  }, [checks, visitProfile, visitFilter, visitRateLimitedOnly, slowThresholdMs]);

  const fieldsStatus = site ? formFieldsStatus(site) : null;
  const detectionTile = site ? formDetectionStatus(site) : null;
  const formBadges = latestForm ? formSummaryBadges(latestForm) : [];
  const formSteps = latestForm ? splitFormNoteSteps(latestForm.notes) : [];
  const formNoteMeta = latestForm ? parseFormNoteMeta(latestForm.notes) : { fallback: null, http: null };
  const egressSource = latestChecksByProfile[0] ?? latestForm ?? null;

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
    <div className="site-detail-page">
      <Link className="subtle-link site-back" to="/">
        <ChevronLeftIcon />
        Back to Dashboard
      </Link>

      <header className="site-hero">
        <div className="site-hero-main">
          <div>
            <h1>{site.name}</h1>
            <p className="site-hero-url">
              <a href={site.main_url} target="_blank" rel="noreferrer">
                {site.main_url}
                <ExternalIcon />
              </a>
            </p>
          </div>
          <div className={`health-pill health-${health}`}>
            <span className={`dot ${health}`} />
            {healthLabel(health)}
          </div>
        </div>
        <div className="site-hero-meta">
          <span>
            {dataAsOf
              ? `Production data as of ${formatPakistanTime(dataAsOf)} ${TIME_LABEL}`
              : 'Loading current production data'}
          </span>
          <button
            type="button"
            className="site-refresh"
            onClick={() => setRefreshKey((key) => key + 1)}
          >
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </header>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="site-dashboard">
          <section className="sd-status-card">
            <div className="sd-section-head">
              <h2>Current status</h2>
            </div>
            <ul className="sd-reason-list">
              {reasons.map((r) => (
                <li key={r}>
                  <span className={`sd-reason-mark ${r === 'All profiles healthy' ? 'ok' : 'warn'}`} />
                  {r}
                </li>
              ))}
            </ul>
            <div className="sd-status-tiles">
              <div className="sd-status-tile">
                <span className="sd-tile-label">Monitoring</span>
                <strong className={site.active ? 'tone-ok' : 'tone-muted'}>
                  {site.active ? 'Active' : 'Paused'}
                </strong>
              </div>
              <div className="sd-status-tile">
                <span className="sd-tile-label">Form test fields</span>
                <strong className={`tone-${fieldsStatus?.tone}`}>{fieldsStatus?.label}</strong>
              </div>
              <div className="sd-status-tile">
                <span className="sd-tile-label">Form detection</span>
                <strong className={`tone-${detectionTile?.tone}`}>{detectionTile?.label}</strong>
              </div>
              <div className="sd-status-tile">
                <span className="sd-tile-label">Open incidents</span>
                <strong className={openIncidents.length ? 'tone-bad' : 'tone-ok'}>
                  {openIncidents.length}
                </strong>
              </div>
            </div>
            <p className="sd-status-meta">
              {site.active ? 'Monitoring active' : 'Site paused'} · {detectionStatusLabel(site)}
            </p>
          </section>

          <div className="sd-main-grid">
            <section className="sd-panel">
              <div className="sd-section-head">
                <h2>Latest load checks</h2>
              </div>
              {checks.length === 0 ? (
                <p className="empty">No load checks yet.</p>
              ) : (
                <div className="sd-load-list">
                  {latestChecksByProfile.map((c) => {
                    const display = loadCheckDisplay(c, slowThresholdMs);
                    const title = `${profileLabel(c.profile)} load check`;
                    return (
                      <article key={c.id} className="sd-load-card">
                        <div className="sd-load-top">
                          <div className="sd-load-identity">
                            <span className="sd-load-icon">
                              <ProfileIcon profile={c.profile} />
                            </span>
                            <div>
                              <strong>{profileLabel(c.profile)}</strong>
                              <span className="meta">{formatRelativeTime(c.checked_at)}</span>
                            </div>
                          </div>
                          <ScreenshotThumb
                            src={c.screenshot_path}
                            alt={title}
                            onOpen={(src) => openShot(src, title)}
                          />
                        </div>
                        <div className="sd-load-metric">
                          <div className="sd-load-metric-row">
                            <span className={`sd-load-ms tone-${display.tone}`}>{display.seconds}</span>
                            <span className={`sd-chip tone-${display.tone}`}>{display.label}</span>
                          </div>
                          <div className="sd-load-bar" aria-hidden="true">
                            <span
                              className={`sd-load-bar-fill tone-${display.tone}`}
                              style={{ width: `${display.barPct}%` }}
                            />
                          </div>
                          <span className="sd-load-threshold">
                            Threshold: {slowThresholdMs}ms
                            {c.load_ms != null ? ` · ${c.load_ms}ms` : ''}
                          </span>
                        </div>
                        <p className="sd-load-location">{formatRunLocation(c)}</p>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="sd-panel sd-form-panel">
              <div className="sd-section-head">
                <h2>Latest form test</h2>
              </div>
              {!latestForm ? (
                <p className="empty">No form tests yet.</p>
              ) : (
                <>
                  <div className="sd-form-badges">
                    {formBadges.map((b) => (
                      <span key={b.label} className={`sd-chip tone-${b.tone}`}>
                        {b.label}
                      </span>
                    ))}
                  </div>

                  <div className="sd-form-meta">
                    <div>
                      <span>Time</span>
                      <strong>{formatRelativeTime(latestForm.tested_at)}</strong>
                    </div>
                    <div>
                      <span>Run ID</span>
                      <strong>
                        <code>{latestForm.run_id}</code>
                      </strong>
                    </div>
                    <div>
                      <span>Brand</span>
                      <strong>{brandFromRunId(latestForm.run_id)}</strong>
                    </div>
                    <div>
                      <span>Fallback</span>
                      <strong>
                        {formNoteMeta.fallback ? `#${formNoteMeta.fallback} (sticky)` : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>HTTP</span>
                      <strong>{formNoteMeta.http ?? '—'}</strong>
                    </div>
                    <div>
                      <span>Proxy</span>
                      <strong>
                        {latestForm.proxy_used
                          ? 'egress'
                          : latestForm.is_production
                            ? 'GitHub Actions'
                            : 'local'}
                      </strong>
                    </div>
                  </div>

                  <div className="sd-form-layers">
                    <span
                      className={`sd-layer-tag ${
                        latestForm.layer3_pass === true
                          ? 'is-on'
                          : latestForm.layer3_pass === false
                            ? 'is-bad'
                            : 'is-off'
                      }`}
                      title="CRM / HubSpot layer"
                    >
                      HubSpot
                    </span>
                    <span
                      className={`sd-layer-tag ${
                        latestForm.layer2_pass === true
                          ? 'is-on'
                          : latestForm.layer2_pass === false
                            ? 'is-bad'
                            : 'is-off'
                      }`}
                      title="Lead email layer"
                    >
                      Email
                    </span>
                  </div>

                  <p className="sd-load-location">Accessed from: {formatRunLocation(latestForm)}</p>

                  {formSteps.length > 0 && (
                    <div className="sd-attempt-steps">
                      <span className="sd-attempt-label">Attempt steps</span>
                      <ul>
                        {formSteps.map((step, index) => {
                          const skipped = /skip|not connected|not found/i.test(step);
                          const failed = /fail|error|timeout|could not/i.test(step);
                          return (
                            <li
                              key={`${index}-${step.slice(0, 48)}`}
                              className={failed ? 'is-bad' : skipped ? 'is-skip' : 'is-ok'}
                            >
                              <span className="sd-attempt-mark" aria-hidden="true">
                                {failed ? '!' : skipped ? '–' : '✓'}
                              </span>
                              <span className="sd-attempt-text">{step}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {latestForm.notes && formSteps.length === 0 && (
                    <p className="notes-block">{latestForm.notes}</p>
                  )}

                  <div className="sd-evidence">
                    <span className="sd-attempt-label">Evidence</span>
                    <ScreenshotEvidence
                      paths={collectScreenshotPaths(
                        latestForm.attempt_screenshot_paths,
                        latestForm.screenshot_path
                      )}
                      altBase={`Form test ${latestForm.run_id}`}
                      onOpen={(src, alt) => openShot(src, alt)}
                    />
                  </div>
                </>
              )}
            </section>
          </div>

          {openIncidents.length > 0 && (
            <section className="sd-panel sd-incidents-panel">
              <div className="sd-section-head">
                <h2>Open incidents ({openIncidents.length})</h2>
              </div>
              {openIncidents.map((i) => (
                <article key={i.id} className="mini-incident">
                  <strong>{incidentTypeLabel(i.type)}</strong>
                  <p>{incidentDetailPlain(i)}</p>
                </article>
              ))}
            </section>
          )}

          {egressFooterText(egressSource) && (
            <p className="sd-egress-footer">{egressFooterText(egressSource)}</p>
          )}
        </div>
      )}

      {tab === 'speed' && (
        <SiteCharts checks={chartChecks} range={chartRange} onRangeChange={setChartRange} />
      )}

      {tab === 'visits' && (
        <div className="site-visits">
          <p className="section-hint">
            Every website load check (Desktop, Safari, Mobile) with screenshot Preview when captured.
          </p>
          <div className="sv-toolbar">
            <div className="filter-bar sv-filters">
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
            <span className="sv-count">{filteredVisits.length} visits</span>
          </div>

          {filteredVisits.length === 0 ? (
            <p className="empty">No load checks match.</p>
          ) : (
            <div className="sv-list">
              {filteredVisits.map((c) => {
                const display = loadCheckDisplay(c, slowThresholdMs);
                const title = `${profileLabel(c.profile)} · ${formatPakistanTime(c.checked_at)}`;
                const notes = (c.notes || '').replace(/\s+/g, ' ').trim();
                return (
                  <article key={c.id} className={`sv-card tone-${display.tone}`}>
                    <div className="sv-when">
                      <strong>{formatRelativeTime(c.checked_at)}</strong>
                      <span>
                        {formatPakistanTime(c.checked_at)} {TIME_LABEL}
                      </span>
                      <span className="sv-browser">
                        <ProfileIcon profile={c.profile} />
                        {profileLabel(c.profile)}
                      </span>
                    </div>

                    <div className="sv-body">
                      <p className="sv-location">
                        <GlobeIcon />
                        <span>{formatRunLocation(c)}</span>
                      </p>
                      <div className="sv-result-row">
                        <span className={`sd-chip tone-${display.tone}`}>{display.chip}</span>
                        {(display.tone === 'ok' || display.tone === 'warn') && c.load_ms != null && (
                          <div className="sv-mini-bar" aria-hidden="true">
                            <span
                              className={`sd-load-bar-fill tone-${display.tone}`}
                              style={{ width: `${display.barPct}%` }}
                            />
                          </div>
                        )}
                      </div>
                      <p className="sv-notes">{notes || '—'}</p>
                    </div>

                    <div className="sv-preview">
                      {c.screenshot_path ? (
                        <ScreenshotThumb
                          className="sv-shot"
                          src={c.screenshot_path}
                          alt={title}
                          onOpen={(src) => openShot(src, title)}
                        />
                      ) : (
                        <div className="sv-shot-empty">
                          <span className="shot-thumb-frame is-empty">No shot</span>
                          <span>Preview</span>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'forms' && (
        <div className="site-forms">
          <div className="sv-toolbar">
            <div className="filter-bar sv-filters">
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
            <span className="sv-count">{filteredForms.length} tests</span>
          </div>

          {filteredForms.length === 0 ? (
            <p className="empty">No form tests match.</p>
          ) : (
            <div className="sf-list">
              {filteredForms.map((f) => {
                const tone = formCardTone(f);
                const badges = formSummaryBadges(f);
                const steps = splitFormNoteSteps(f.notes);
                const { location, proxy } = formRunLocationParts(f);
                const paths = collectScreenshotPaths(f.attempt_screenshot_paths, f.screenshot_path);
                const expanded = Boolean(expandedFormIds[f.id]);
                return (
                  <article key={f.id} className={`sf-card tone-${tone}`}>
                    <header className="sf-card-head">
                      <div className="sf-when">
                        <strong>{formatRelativeTime(f.tested_at)}</strong>
                        <span>
                          {formatPakistanTime(f.tested_at)} {TIME_LABEL}
                        </span>
                      </div>
                      <div className="sf-badges">
                        {badges.map((b) => (
                          <span key={b.label} className={`sd-chip tone-${b.tone}`}>
                            {b.label}
                          </span>
                        ))}
                      </div>
                    </header>

                    <div className="sf-meta">
                      <div>
                        <span>Run ID</span>
                        <strong>
                          <code>{f.run_id}</code>
                        </strong>
                      </div>
                      <div>
                        <span>Location</span>
                        <strong>{location}</strong>
                      </div>
                      <div>
                        <span>Proxy</span>
                        <strong>{proxy}</strong>
                      </div>
                    </div>

                    <div className="sf-footer">
                      {steps.length > 0 ? (
                        <div className="sf-steps-block">
                          <button
                            type="button"
                            className="sf-steps-toggle"
                            onClick={() =>
                              setExpandedFormIds((prev) => ({ ...prev, [f.id]: !prev[f.id] }))
                            }
                          >
                            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                            {expanded ? 'Hide' : 'Show'} attempt steps ({steps.length})
                          </button>
                          {expanded && (
                            <ul className="sf-steps">
                              {steps.map((step, index) => {
                                const skipped = /skip|not connected|not found/i.test(step);
                                const failed = /fail|error|timeout|could not/i.test(step);
                                return (
                                  <li
                                    key={`${f.id}-${index}`}
                                    className={failed ? 'is-bad' : skipped ? 'is-skip' : 'is-ok'}
                                  >
                                    <span className="sd-attempt-mark" aria-hidden="true">
                                      {failed ? '!' : skipped ? '–' : '✓'}
                                    </span>
                                    <span className="sd-attempt-text">{step}</span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <p className="sf-notes">{(f.notes || '—').replace(/\s+/g, ' ').trim()}</p>
                      )}

                      <div className="sf-evidence">
                        <span className="sd-attempt-label">Evidence</span>
                        {paths.length === 0 ? (
                          <span className="muted-text">No screenshots</span>
                        ) : (
                          <div className="sf-evidence-atts">
                            {paths.map((path, index) => {
                              const label = paths.length === 1 ? 'Preview' : `Att ${index + 1}`;
                              const alt = `${f.run_id} — ${label}`;
                              return (
                                <ScreenshotThumb
                                  key={`${path}-${index}`}
                                  className="sv-shot sf-shot"
                                  src={path}
                                  label={label}
                                  alt={alt}
                                  onOpen={(src) => openShot(src, alt)}
                                />
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
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
                <ScreenshotEvidence
                  paths={collectScreenshotPaths(i.screenshot_paths, i.screenshot_path)}
                  altBase={incidentTypeLabel(i.type)}
                  onOpen={(src, alt) => openShot(src, alt)}
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
                <ScreenshotEvidence
                  paths={collectScreenshotPaths(i.screenshot_paths, i.screenshot_path)}
                  altBase={incidentTypeLabel(i.type)}
                  onOpen={(src, alt) => openShot(src, alt)}
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
          slowThresholdMs={slowThresholdMs}
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

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M10 3.5 5.5 8 10 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M7 9l5.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M2.5 8h11M8 2.5c1.6 1.8 2.4 3.6 2.4 5.5S9.6 11.7 8 13.5C6.4 11.7 5.6 9.9 5.6 8S6.4 4.3 8 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M13.2 8A5.2 5.2 0 1 1 11.4 3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M11 1.8v2.8h2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
