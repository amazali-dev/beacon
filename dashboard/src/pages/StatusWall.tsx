import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import {
  detectionStatusLabel,
  formTestPassed,
  formTestSummary,
  healthFromChecks,
  healthReasons,
  healthSortOrder,
} from '../lib/labelMappers';
import { engineOnline, loadBeaconSettings, type BeaconSettings } from '../lib/operations';
import { isRateLimitedFormTest } from '../lib/healthScoring';
import {
  formatCountdown,
  formatPakistanTime,
  formatRelativeTime,
  getNextFormTestAt,
  getNextLoadCheckAt,
  TIME_LABEL,
} from '../lib/time';
import type { FormTest, Health, Incident, LoadCheck, Site } from '../lib/types';

type SiteSummary = {
  site: Site;
  health: Health;
  reasons: string[];
  lastCheck: string | null;
  openIncidents: number;
  hasCriticalIncident: boolean;
  latestForm: FormTest | null;
  desktopLoadMs: number | null;
};

function buildSummaries(
  sites: Site[],
  checks: LoadCheck[],
  incidents: Incident[],
  formTests: FormTest[],
  slowThresholdMs: number
): SiteSummary[] {
  const checksBySite = new Map<string, LoadCheck[]>();
  for (const c of checks) {
    const list = checksBySite.get(c.site_id) || [];
    list.push(c);
    checksBySite.set(c.site_id, list);
  }

  const openBySite = new Map<string, number>();
  const criticalBySite = new Map<string, boolean>();
  for (const i of incidents) {
    if (!i.closed_at) {
      openBySite.set(i.site_id, (openBySite.get(i.site_id) || 0) + 1);
      if (['load_failure', 'load_check_failure', 'form_test_failure'].includes(i.type)) {
        criticalBySite.set(i.site_id, true);
      }
    }
  }

  const latestFormBySite = new Map<string, FormTest>();
  for (const f of formTests) {
    if (!latestFormBySite.has(f.site_id)) latestFormBySite.set(f.site_id, f);
  }

  return sites.map((site) => {
    const siteChecks = checksBySite.get(site.id) || [];
    const health = site.active ? healthFromChecks(siteChecks, slowThresholdMs) : 'gray';
    const desktop = siteChecks.find((c) => c.profile === 'desktop');
    return {
      site,
      health,
      reasons: healthReasons(siteChecks, slowThresholdMs),
      lastCheck: siteChecks[0]?.checked_at ?? null,
      openIncidents: openBySite.get(site.id) || 0,
      hasCriticalIncident: criticalBySite.get(site.id) || false,
      latestForm: latestFormBySite.get(site.id) ?? null,
      desktopLoadMs: desktop?.load_ms ?? siteChecks[0]?.load_ms ?? null,
    };
  });
}

function effectiveHealth(summary: SiteSummary): Health {
  if (summary.hasCriticalIncident && summary.health !== 'gray') return 'red';
  if (summary.openIncidents > 0 && summary.health === 'green') return 'yellow';
  if (
    summary.latestForm &&
    !isRateLimitedFormTest(summary.latestForm) &&
    summary.latestForm.outcome !== 'monitor_error' &&
    !formTestPassed(summary.latestForm)
  ) return 'yellow';
  return summary.health;
}

function FleetDonut({
  healthy,
  attention,
  down,
  total,
}: {
  healthy: number;
  attention: number;
  down: number;
  total: number;
}) {
  const size = 118;
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const safeTotal = Math.max(total, 1);
  const segs = [
    { n: healthy, color: 'var(--ok)' },
    { n: attention, color: 'var(--warn)' },
    { n: down, color: 'var(--bad)' },
    { n: Math.max(0, total - healthy - attention - down), color: '#5a7078' },
  ];

  let offset = 0;
  const arcs = segs
    .filter((s) => s.n > 0)
    .map((s) => {
      const len = (s.n / safeTotal) * c;
      const arc = { color: s.color, len, offset };
      offset += len;
      return arc;
    });

  return (
    <div className="fleet-donut" aria-hidden>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={stroke}
        />
        {arcs.map((arc) => (
          <circle
            key={`${arc.color}-${arc.offset}`}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={arc.color}
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={`${arc.len} ${c - arc.len}`}
            strokeDashoffset={-arc.offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ))}
      </svg>
      <div className="fleet-donut-label">
        <strong>{healthy}</strong>
        <span>of {total} OK</span>
      </div>
    </div>
  );
}

function FleetHealthHero({
  counts,
  totalSites,
  openIncidents,
  settings,
  geoLabel,
  geoIp,
  geoSource,
  online,
  engineMode,
  heartbeat,
  engineCommitSha,
}: {
  counts: { healthy: number; attention: number; down: number };
  totalSites: number;
  openIncidents: number;
  settings: BeaconSettings | null;
  geoLabel: string | null;
  geoIp: string | null;
  geoSource: string | null;
  online: boolean;
  engineMode: string | null;
  heartbeat: string | null;
  engineCommitSha: string | null;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const formTimes = settings?.formTestTimesEastern?.length
    ? settings.formTestTimesEastern
    : [
        '00:00',
        '02:00',
        '04:00',
        '06:00',
        '08:00',
        '10:00',
        '12:00',
        '14:00',
        '16:00',
        '18:00',
        '20:00',
        '22:00',
      ];
  const nextLoad = getNextLoadCheckAt(now);
  const nextForm = getNextFormTestAt(formTimes, now);

  return (
    <section className="fleet-health-hero" aria-live="polite">
      <div className="fleet-health-main">
        <FleetDonut
          healthy={counts.healthy}
          attention={counts.attention}
          down={counts.down}
          total={totalSites}
        />
        <div className="fleet-health-copy">
          <h2>Fleet health</h2>
          <p className="fleet-health-sub">Latest production checks</p>
          <ul className="fleet-health-stats">
            <li className="tone-ok">
              <strong>{counts.healthy}</strong> Healthy
            </li>
            <li className="tone-warn">
              <strong>{counts.attention}</strong> Attention
            </li>
            <li className="tone-bad">
              <strong>{counts.down}</strong> Down
            </li>
            <li className="tone-incidents">
              <strong>{openIncidents}</strong> Incidents
            </li>
          </ul>
          <p className="fleet-health-meta">
            {online ? 'Engine online' : 'Engine offline'}
            {engineMode ? ` · ${engineMode}` : ''}
            {heartbeat ? ` · ${formatRelativeTime(heartbeat)}` : ''}
            {engineCommitSha ? ` · ${engineCommitSha.slice(0, 7)}` : ''}
            {geoLabel
              ? ` · ${geoLabel}${geoIp ? ` · IP ${geoIp}` : ''}${geoSource ? ` · ${geoSource}` : ''}`
              : ''}
          </p>
        </div>
      </div>

      <div className="fleet-health-timers">
        <div className="fleet-timer">
          <span className="fleet-timer-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 8v4.2l2.6 1.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <span className="fleet-timer-label">Load check</span>
            <strong className="fleet-timer-countdown">{formatCountdown(nextLoad, now)}</strong>
            <span className="fleet-timer-when">
              30 min · {formatPakistanTime(nextLoad.toISOString())} {TIME_LABEL}
            </span>
          </div>
        </div>
        <div className="fleet-timer">
          <span className="fleet-timer-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M7 3.75h7.2L19 8.6v11.65H7V3.75Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path d="M14 3.75V8.5h4.8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <span className="fleet-timer-label">Form test</span>
            <strong className="fleet-timer-countdown">
              {nextForm ? formatCountdown(nextForm, now) : '—'}
            </strong>
            <span className="fleet-timer-when">
              {nextForm
                ? `${formTimes.length}× daily · ${formatPakistanTime(nextForm.toISOString())} ${TIME_LABEL}`
                : 'Schedule not set'}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Dashboard() {
  const [sites, setSites] = useState<Site[]>([]);
  const [checks, setChecks] = useState<LoadCheck[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [formTests, setFormTests] = useState<FormTest[]>([]);
  const [heartbeat, setHeartbeat] = useState<string | null>(null);
  const [engineMode, setEngineMode] = useState<string | null>(null);
  const [settings, setSettings] = useState<BeaconSettings | null>(null);
  const [geoLabel, setGeoLabel] = useState<string | null>(null);
  const [geoIp, setGeoIp] = useState<string | null>(null);
  const [geoSource, setGeoSource] = useState<string | null>(null);
  const [engineCommitSha, setEngineCommitSha] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [
        { data: siteRows, error: sErr },
        { data: checkRows, error: cErr },
        { data: incRows },
        { data: formRows },
        loaded,
      ] = await Promise.all([
        supabase.from('sites').select('*').order('name'),
        supabase
          .from('load_checks')
          .select('*')
          .eq('is_production', true)
          .order('checked_at', { ascending: false })
          .limit(300),
        supabase
          .from('incidents')
          .select('*')
          .eq('is_production', true)
          .is('closed_at', null)
          .order('opened_at', { ascending: false })
          .limit(100),
        supabase
          .from('form_tests')
          .select('*')
          .eq('is_production', true)
          .order('tested_at', { ascending: false })
          .limit(200),
        loadBeaconSettings().catch(() => ({
          settings: null as unknown as BeaconSettings,
          heartbeat: null,
          engineMode: null,
          geoCountry: null,
          geoIp: null,
          geoLabel: null,
          geoSource: null,
          lastLoadCompletedAt: null,
          engineCommitSha: null,
        })),
      ]);
      if (cancelled) return;
      if (sErr || cErr) {
        setError(sErr?.message || cErr?.message || 'Load failed');
        return;
      }
      setSites((siteRows || []) as Site[]);
      setChecks((checkRows || []) as LoadCheck[]);
      setIncidents((incRows || []) as Incident[]);
      setFormTests((formRows || []) as FormTest[]);
      setHeartbeat(loaded.lastLoadCompletedAt || loaded.heartbeat);
      setEngineMode(loaded.engineMode);
      setSettings(loaded.settings ?? null);
      setGeoLabel(loaded.geoLabel);
      setGeoIp(loaded.geoIp);
      setGeoSource(loaded.geoSource);
      setEngineCommitSha(loaded.engineCommitSha);
      setError(null);
    }
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const summaries = useMemo(
    () =>
      buildSummaries(
        sites,
        checks,
        incidents,
        formTests,
        settings?.loadTimeThresholdMs || 8000
      ),
    [sites, checks, incidents, formTests, settings?.loadTimeThresholdMs]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summaries
      .filter((s) => !q || s.site.name.toLowerCase().includes(q) || s.site.main_url.toLowerCase().includes(q))
      .sort((a, b) => {
        const ha = healthSortOrder(effectiveHealth(a));
        const hb = healthSortOrder(effectiveHealth(b));
        if (ha !== hb) return ha - hb;
        return a.site.name.localeCompare(b.site.name);
      });
  }, [summaries, search]);

  const attention = filtered.filter((s) => effectiveHealth(s) !== 'green');
  const healthy = filtered.filter((s) => effectiveHealth(s) === 'green');
  const online = engineOnline(heartbeat);

  const counts = {
    healthy: summaries.filter((s) => effectiveHealth(s) === 'green').length,
    attention: summaries.filter((s) => effectiveHealth(s) === 'yellow').length,
    down: summaries.filter((s) => effectiveHealth(s) === 'red').length,
  };
  const openIncidents = summaries.reduce((n, s) => n + s.openIncidents, 0);

  return (
    <div>
      <div className="page-head">
        <h1>Dashboard</h1>
        <p>What needs attention right now across your quote sites.</p>
      </div>

      {error && <p className="error">{error}</p>}

      <FleetHealthHero
        counts={counts}
        totalSites={summaries.length}
        openIncidents={openIncidents}
        settings={settings}
        geoLabel={geoLabel}
        geoIp={geoIp}
        geoSource={geoSource}
        online={online}
        engineMode={engineMode}
        heartbeat={heartbeat}
        engineCommitSha={engineCommitSha}
      />

      <div className="fleet-toolbar">
        <label className="fleet-search">
          <span className="sr-only">Filter by site name or URL</span>
          <span className="fleet-search-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M16 16.5 20 20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by site name or URL..."
          />
        </label>
        <Link className="fleet-run-btn" to="/operations">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path d="M19.5 4.5v4.2h-4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Run checks
        </Link>
      </div>

      {attention.length > 0 && (
        <section className="site-section">
          <h2>
            Needs attention <span className="section-count">{attention.length}</span>
          </h2>
          <div className="status-grid">
            {attention.map((s) => (
              <SiteCard
                key={s.site.id}
                summary={s}
                slowThresholdMs={settings?.loadTimeThresholdMs || 8000}
              />
            ))}
          </div>
        </section>
      )}

      <section className="site-section">
        <h2>{attention.length > 0 ? `All clear (${healthy.length})` : `All sites (${filtered.length})`}</h2>
        <div className="status-grid">
          {(attention.length > 0 ? healthy : filtered).map((s) => (
            <SiteCard
              key={s.site.id}
              summary={s}
              slowThresholdMs={settings?.loadTimeThresholdMs || 8000}
            />
          ))}
        </div>
      </section>

      {filtered.length === 0 && !error && (
        <p className="empty">No sites match your search. Add sites under Sites.</p>
      )}
    </div>
  );
}

function SiteCard({
  summary,
  slowThresholdMs = 8000,
}: {
  summary: SiteSummary;
  slowThresholdMs?: number;
}) {
  const health = effectiveHealth(summary);
  const { site, reasons, lastCheck, openIncidents, latestForm, desktopLoadMs } = summary;
  const slowThreshold = slowThresholdMs;

  const statusPill =
    health === 'green' ? 'Healthy' : health === 'yellow' ? 'Attention' : health === 'red' ? 'Down' : 'Paused';

  const loadTone =
    desktopLoadMs == null
      ? 'muted'
      : desktopLoadMs >= slowThreshold
        ? 'bad'
        : desktopLoadMs >= slowThreshold * 0.75
          ? 'warn'
          : 'ok';
  const loadLabel =
    desktopLoadMs == null
      ? '—'
      : desktopLoadMs >= slowThreshold
        ? 'Slow'
        : 'OK';

  const formSkipped = latestForm ? isRateLimitedFormTest(latestForm) : false;
  const formMonitorError = latestForm?.outcome === 'monitor_error';
  const formOk = latestForm ? !formSkipped && !formMonitorError && formTestPassed(latestForm) : false;
  const formFail =
    latestForm && !formSkipped && !formMonitorError && !formTestPassed(latestForm);

  const formTone = !latestForm
    ? 'muted'
    : formSkipped || formMonitorError
      ? 'warn'
      : formOk
        ? 'ok'
        : 'bad';
  const formTitle = !latestForm
    ? site.form_testing_enabled
      ? 'No runs'
      : 'Off'
    : formSkipped
      ? 'Skipped'
      : formMonitorError
        ? 'Monitor error'
        : formOk
          ? 'Passed'
          : 'Failed';

  const banners: Array<{ tone: 'warn' | 'bad' | 'ok'; text: string }> = [];
  for (const reason of reasons.slice(0, 2)) {
    if (/^all profiles healthy$/i.test(reason)) {
      const text =
        latestForm?.logo_upload_ok === true
          ? 'All profiles healthy · Logo uploaded OK'
          : reason;
      banners.push({ tone: 'ok', text });
      continue;
    }
    const tone = /rate.?limit|429|stale/i.test(reason)
      ? 'warn'
      : /slow|not found|did not load|failed/i.test(reason) || health === 'red'
        ? 'bad'
        : 'warn';
    banners.push({ tone, text: reason });
  }
  if (latestForm && formSkipped) {
    banners.push({ tone: 'warn', text: formTestSummary(latestForm) });
  } else if (formFail && latestForm) {
    banners.push({ tone: 'bad', text: formTestSummary(latestForm) });
  } else if (
    formOk &&
    latestForm?.logo_upload_ok === true &&
    !banners.some((b) => /logo uploaded ok/i.test(b.text))
  ) {
    banners.push({ tone: 'ok', text: 'Form passed — logo upload OK.' });
  }

  // Dedupe similar banners
  const uniqueBanners = banners.filter(
    (b, i, arr) => arr.findIndex((x) => x.text === b.text) === i
  ).slice(0, 2);

  return (
    <article className={`fleet-card health-${health}`}>
      <header className="fleet-card-head">
        <div>
          <h2>{site.name}</h2>
          <a className="fleet-card-url" href={site.main_url} target="_blank" rel="noreferrer">
            {site.main_url.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
          </a>
        </div>
        <span className={`fleet-pill fleet-pill-${health}`}>{statusPill}</span>
      </header>

      <ul className="fleet-metrics">
        <li>
          <span className="fleet-metric-label">Load time</span>
          <strong className={`fleet-metric-value tone-${loadTone}`}>
            {desktopLoadMs != null ? `${desktopLoadMs}ms` : '—'}
          </strong>
          <span className={`fleet-metric-tag tone-${loadTone}`}>{loadLabel}</span>
        </li>
        <li>
          <span className="fleet-metric-label">Form test</span>
          <strong className={`fleet-metric-value tone-${formTone}`}>{formTitle}</strong>
          <span className="fleet-metric-tag meta">
            {latestForm ? formatRelativeTime(latestForm.tested_at) : detectionStatusLabel(site)}
          </span>
        </li>
        <li>
          <span className="fleet-metric-label">Incidents</span>
          <strong className={`fleet-metric-value ${openIncidents ? 'tone-bad' : 'tone-ok'}`}>
            {openIncidents || 0}
          </strong>
          <span className={`fleet-metric-tag ${openIncidents ? 'tone-bad' : 'meta'}`}>
            {openIncidents ? 'Open' : 'None'}
          </span>
        </li>
      </ul>

      {uniqueBanners.length > 0 && (
        <div className="fleet-banners">
          {uniqueBanners.map((b) => (
            <p key={b.text} className={`fleet-banner fleet-banner-${b.tone}`}>
              {b.text}
            </p>
          ))}
        </div>
      )}

      <footer className="fleet-card-foot">
        <span>
          Checked {formatRelativeTime(lastCheck)} {TIME_LABEL}
          {!site.active ? ' · Paused' : ''}
        </span>
        <Link to={`/site/${site.id}`}>View details</Link>
      </footer>
    </article>
  );
}

/** @deprecated use Dashboard — kept for route compatibility */
export const StatusWall = Dashboard;
