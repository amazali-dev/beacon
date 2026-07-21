import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import {
  detectionStatusLabel,
  formTestPassed,
  formTestSummary,
  healthFromChecks,
  healthLabel,
  healthReasons,
  healthSortOrder,
  profileLabel,
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

function NextRunTimers({
  settings,
  geoLabel,
  geoIp,
  geoSource,
}: {
  settings: BeaconSettings | null;
  geoLabel: string | null;
  geoIp: string | null;
  geoSource: string | null;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const nextLoad = getNextLoadCheckAt(now);
  const nextForm = getNextFormTestAt(
    settings?.formTestTimesEastern || ['00:00', '06:00', '12:00', '18:00'],
    now
  );

  return (
    <section className="next-run-panel" aria-live="polite">
      <div className="next-run-card">
        <span className="next-run-label">Next load check</span>
        <strong className="next-run-countdown">{formatCountdown(nextLoad, now)}</strong>
        <span className="next-run-when">
          {formatPakistanTime(nextLoad.toISOString())} {TIME_LABEL} · every 30 min (GitHub)
        </span>
      </div>
      <div className="next-run-card">
        <span className="next-run-label">Next form test</span>
        <strong className="next-run-countdown">
          {nextForm ? formatCountdown(nextForm, now) : '—'}
        </strong>
        <span className="next-run-when">
          {nextForm
            ? `${formatPakistanTime(nextForm.toISOString())} ${TIME_LABEL} · 4× daily`
            : 'Schedule not set'}
        </span>
      </div>
      <div className="next-run-card location-card">
        <span className="next-run-label">Checks run from</span>
        <strong className="next-run-countdown location-text">
          {geoLabel || 'Waiting for first GitHub run'}
        </strong>
        <span className="next-run-when">
          {geoIp
            ? `IP ${geoIp}${geoSource ? ` · ${geoSource}` : ''}`
            : 'Location is recorded at the start of each US workflow'}
        </span>
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
    attention: summaries.filter((s) => effectiveHealth(s) !== 'green' && effectiveHealth(s) !== 'gray').length,
    down: summaries.filter((s) => effectiveHealth(s) === 'red').length,
  };

  return (
    <div>
      <div className="page-head">
        <h1>Dashboard</h1>
        <p>What needs attention right now across your quote sites.</p>
      </div>

      {error && <p className="error">{error}</p>}

      <NextRunTimers
        settings={settings}
        geoLabel={geoLabel}
        geoIp={geoIp}
        geoSource={geoSource}
      />

      <section className="fleet-summary">
        <div className="summary-stat">
          <strong>{sites.length}</strong>
          <span>Sites</span>
        </div>
        <div className="summary-stat ok-stat">
          <strong>{counts.healthy}</strong>
          <span>Healthy</span>
        </div>
        <div className="summary-stat warn-stat">
          <strong>{counts.attention}</strong>
          <span>Needs attention</span>
        </div>
        <div className="summary-stat bad-stat">
          <strong>{counts.down}</strong>
          <span>Down / open issues</span>
        </div>
        <div className={`summary-stat engine-stat ${online ? 'online' : 'offline'}`}>
          <strong>{online ? 'Online' : 'Offline'}</strong>
          <span>
            {online
              ? `GitHub Actions · ${engineMode || 'production'} · ${formatRelativeTime(heartbeat)}${engineCommitSha ? ` · ${engineCommitSha.slice(0, 7)}` : ''}`
              : 'Waiting for next GitHub Actions run (every 30 min)'}
          </span>
        </div>
      </section>

      <div className="filter-bar">
        <label className="search-field">
          Search sites
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name or URL…"
          />
        </label>
        <Link className="button-link" to="/operations">
          Run checks →
        </Link>
      </div>

      {attention.length > 0 && (
        <section className="site-section">
          <h2>Needs attention ({attention.length})</h2>
          <div className="status-grid">
            {attention.map((s) => (
              <SiteCard key={s.site.id} summary={s} />
            ))}
          </div>
        </section>
      )}

      <section className="site-section">
        <h2>{attention.length > 0 ? `All clear (${healthy.length})` : `All sites (${filtered.length})`}</h2>
        <div className="status-grid">
          {(attention.length > 0 ? healthy : filtered).map((s) => (
            <SiteCard key={s.site.id} summary={s} />
          ))}
        </div>
      </section>

      {filtered.length === 0 && !error && (
        <p className="empty">No sites match your search. Add sites under Sites.</p>
      )}
    </div>
  );
}

function SiteCard({ summary }: { summary: SiteSummary }) {
  const health = effectiveHealth(summary);
  const { site, reasons, lastCheck, openIncidents, latestForm, desktopLoadMs } = summary;

  const formNote =
    latestForm && !formTestPassed(latestForm) ? formTestSummary(latestForm) : '';

  return (
    <article className={`status-card health-${health} enriched`}>
      <header>
        <div>
          <h2>{site.name}</h2>
          <p className="meta">{healthLabel(health)}</p>
        </div>
        <span className={`dot ${health}`} title={healthLabel(health)} />
      </header>

      <p className="url">
        <a href={site.main_url} target="_blank" rel="noreferrer">
          {site.main_url}
        </a>
      </p>

      <ul className="card-metrics">
        <li>
          <span>Load</span>
          <strong>{desktopLoadMs != null ? `${desktopLoadMs}ms` : '—'}</strong>
          <span className="meta">{profileLabel('desktop')}</span>
        </li>
        <li>
          <span>Form</span>
          <strong>
            {latestForm
              ? isRateLimitedFormTest(latestForm)
                ? 'Skipped'
                : latestForm.outcome === 'monitor_error'
                  ? 'Monitor error'
                : formTestPassed(latestForm)
                ? 'Passed'
                : 'Failed'
              : site.form_testing_enabled
                ? 'No runs'
                : 'Off'}
          </strong>
          <span className="meta">
            {latestForm ? formatRelativeTime(latestForm.tested_at) : detectionStatusLabel(site)}
          </span>
        </li>
        <li>
          <span>Issues</span>
          <strong>{openIncidents || 'None'}</strong>
          <span className="meta">Open incidents</span>
        </li>
      </ul>

      {health !== 'green' && (
        <p className="card-reason">
          {reasons[0]}
          {formNote ? ` · ${formNote}` : ''}
        </p>
      )}

      <p className="meta">
        Last check: {formatRelativeTime(lastCheck)} {TIME_LABEL}
        {!site.active && ' · Paused'}
      </p>

      <Link className="subtle-link" to={`/site/${site.id}`}>
        View site detail →
      </Link>
    </article>
  );
}

/** @deprecated use Dashboard — kept for route compatibility */
export const StatusWall = Dashboard;
