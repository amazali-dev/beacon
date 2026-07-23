import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ScreenshotAttButton, ScreenshotModal } from '../components/ScreenshotModal';
import { incidentDetailPlain, incidentTypeLabel } from '../lib/labelMappers';
import { supabase } from '../lib/supabase';
import { formatPakistanTime, formatRelativeTime, TIME_LABEL } from '../lib/time';
import type { Incident, Site } from '../lib/types';

type TypeTone = 'bad' | 'warn' | 'warn-soft' | 'ok' | 'muted';

function canonicalIncidentType(type: string): string {
  if (type === 'load_check_failure') return 'load_failure';
  return type;
}

function incidentTypeTone(type: string): TypeTone {
  switch (canonicalIncidentType(type)) {
    case 'form_test_failure':
    case 'load_failure':
    case 'check_failed_to_run':
    case 'form_check_failed_to_run':
    case 'engine_down':
      return 'bad';
    case 'slow_load':
    case 'rate_limited':
      return 'warn';
    case 'missing_element':
      return 'warn-soft';
    case 'form_logo_upload_recovered':
      return 'ok';
    default:
      return 'muted';
  }
}

export function IncidentsPage() {
  const [rows, setRows] = useState<Incident[]>([]);
  const [sites, setSites] = useState<Record<string, Site>>({});
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: siteRows }, { data: openRows }, { data: closedRows }] = await Promise.all([
      supabase.from('sites').select('*'),
      supabase
        .from('incidents')
        .select('*')
        .eq('is_production', true)
        .is('closed_at', null)
        .order('opened_at', { ascending: false }),
      supabase
        .from('incidents')
        .select('*')
        .eq('is_production', true)
        .not('closed_at', 'is', null)
        .order('opened_at', { ascending: false })
        .limit(500),
    ]);
    const map: Record<string, Site> = {};
    for (const s of (siteRows || []) as Site[]) map[s.id] = s;
    setSites(map);
    setRows([...(openRows || []), ...(closedRows || [])] as Incident[]);
    setLoadedAt(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const siteName = sites[r.site_id]?.name || '';
      if (q && !`${siteName} ${r.type} ${r.detail || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, sites, query]);

  const openAll = useMemo(() => searched.filter((r) => !r.closed_at), [searched]);
  const closedAll = useMemo(() => searched.filter((r) => r.closed_at), [searched]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of openAll) {
      const key = canonicalIncidentType(r.type);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count, label: incidentTypeLabel(type), tone: incidentTypeTone(type) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [openAll]);

  const openTotal = openAll.length;
  const typeOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const r of searched) keys.add(canonicalIncidentType(r.type));
    return [...keys]
      .map((type) => ({ type, label: incidentTypeLabel(type) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [searched]);

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return searched;
    return searched.filter((r) => canonicalIncidentType(r.type) === typeFilter);
  }, [searched, typeFilter]);

  const open = filtered.filter((r) => !r.closed_at);
  const closed = filtered.filter((r) => r.closed_at);

  const loadedLabel = (() => {
    if (!loadedAt) return loading ? 'Loading…' : 'Not loaded';
    const secs = Math.max(0, Math.floor((now - loadedAt.getTime()) / 1000));
    if (secs < 15) return 'Loaded just now';
    if (secs < 60) return `Loaded ${secs}s ago`;
    return `Loaded ${formatRelativeTime(loadedAt.toISOString())}`;
  })();

  return (
    <div className="incidents-page">
      <div className="incidents-page-head">
        <div>
          <div className="incidents-title-row">
            <h1>Incidents</h1>
            {openTotal > 0 && (
              <span className="incidents-open-chip">{openTotal} open</span>
            )}
          </div>
          <p>Open problems first, sorted newest to oldest.</p>
        </div>
        <div className="incidents-head-actions">
          <span className="incidents-loaded">{loadedLabel}</span>
          <button
            type="button"
            className="incidents-refresh"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshIcon />
            Refresh
          </button>
        </div>
      </div>

      {openTotal > 0 && (
        <div className="incident-type-summary">
          <div className="incident-type-bar" role="img" aria-label="Open incidents by type">
            {typeCounts.map((t) => (
              <span
                key={t.type}
                className={`incident-type-seg tone-${t.tone}`}
                style={{ flexGrow: t.count, flexBasis: 0 }}
                title={`${t.label}: ${t.count}`}
              />
            ))}
          </div>
          <div className="incident-type-legend">
            {typeCounts.map((t) => (
              <button
                key={t.type}
                type="button"
                className={`incident-legend-item ${typeFilter === t.type ? 'is-active' : ''}`}
                onClick={() => setTypeFilter((cur) => (cur === t.type ? 'all' : t.type))}
              >
                <span className={`incident-legend-dot tone-${t.tone}`} />
                {t.label} <strong>{t.count}</strong>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="incidents-filters">
        <label className="incidents-search">
          <span className="sr-only">Search</span>
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Site, type, or detail…"
          />
        </label>
        <label className="incidents-type-select">
          <span className="sr-only">Type</span>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            {typeOptions.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {openTotal > 0 && (
        <div className="incident-type-pills" role="toolbar" aria-label="Filter by type">
          <button
            type="button"
            className={`incident-type-pill ${typeFilter === 'all' ? 'is-active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >
            All {openTotal}
          </button>
          {typeCounts.map((t) => (
            <button
              key={t.type}
              type="button"
              className={`incident-type-pill tone-${t.tone} ${typeFilter === t.type ? 'is-active' : ''}`}
              onClick={() => setTypeFilter((cur) => (cur === t.type ? 'all' : t.type))}
            >
              <TypeIcon type={t.type} />
              {t.label} {t.count}
            </button>
          ))}
        </div>
      )}

      <section className="incident-queue">
        <div className="incident-queue-head">
          <h2>Open</h2>
          <span className="incident-queue-count">{open.length}</span>
        </div>
        {open.length === 0 ? (
          <p className="empty">No open incidents — that is a good sign.</p>
        ) : (
          open.map((r) => (
            <IncidentCard
              key={r.id}
              incident={r}
              site={sites[r.site_id]}
              onOpenShot={(src, alt) => setModal({ src, alt })}
            />
          ))
        )}
      </section>

      <button
        type="button"
        className="linkish advanced-toggle"
        onClick={() => setShowClosed((v) => !v)}
      >
        {showClosed ? 'Hide' : 'Show'} closed incidents ({closed.length}
        {closedAll.length !== closed.length ? ` of ${closedAll.length}` : ''})
      </button>

      {showClosed && (
        <section className="incident-queue closed-section">
          <div className="incident-queue-head is-closed">
            <h2>Closed</h2>
            <span className="incident-queue-count is-muted">{closed.length}</span>
          </div>
          {closed.length === 0 ? (
            <p className="empty">No closed incidents match these filters.</p>
          ) : (
            closed.map((r) => (
              <IncidentCard
                key={r.id}
                incident={r}
                site={sites[r.site_id]}
                onOpenShot={(src, alt) => setModal({ src, alt })}
              />
            ))
          )}
        </section>
      )}

      <ScreenshotModal
        src={modal?.src ?? null}
        alt={modal?.alt}
        onClose={() => setModal(null)}
      />
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.4 10.4 13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M13.2 8A5.2 5.2 0 1 1 11.4 3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M11 1.8v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TypeIcon({ type }: { type: string }) {
  const t = canonicalIncidentType(type);
  const common = {
    viewBox: '0 0 16 16',
    width: 12,
    height: 12,
    'aria-hidden': true as const,
  };

  if (t === 'slow_load') {
    return (
      <svg {...common}>
        <path d="M8.8 1.5 3.5 9h4.2L7.2 14.5 12.5 7H8.3L8.8 1.5Z" fill="currentColor" />
      </svg>
    );
  }
  if (t === 'missing_element') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M5.9 6.1a2.1 2.1 0 1 1 2.5 2c-.7.3-1 .8-1 1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.35" r="0.8" fill="currentColor" />
      </svg>
    );
  }
  if (t === 'form_logo_upload_recovered') {
    return (
      <svg {...common}>
        <path
          d="M3.5 8.2 6.4 11l6.1-6.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.85" fill="currentColor" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function IncidentCard({
  incident,
  site,
  onOpenShot,
}: {
  incident: Incident;
  site?: Site;
  onOpenShot: (src: string, alt: string) => void;
}) {
  const isOpen = !incident.closed_at;
  const title = incidentTypeLabel(incident.type);
  const tone = incidentTypeTone(incident.type);
  const evidencePaths = Array.from(
    new Set(
      [...(incident.screenshot_paths || []), incident.screenshot_path].filter(
        (path): path is string => Boolean(path)
      )
    )
  );

  let siteLabel: ReactNode = 'Site';
  if (site) {
    siteLabel = <Link to={`/site/${site.id}?tab=incidents`}>{site.name}</Link>;
  }

  return (
    <article className={`incident-card ${isOpen ? 'is-open' : 'is-closed'}`}>
      <header className="incident-card-head">
        <div className="incident-card-title">
          <strong className="incident-card-site">{siteLabel}</strong>
          <span className={`incident-type-badge tone-${tone}`}>
            <TypeIcon type={incident.type} />
            {title}
          </span>
        </div>
        <span className={`incident-status-badge ${isOpen ? 'is-open' : 'is-closed'}`}>
          <span className="incident-status-dot" aria-hidden="true" />
          {isOpen ? 'Open' : 'Closed'}
        </span>
      </header>

      <p className="incident-card-detail">{incidentDetailPlain(incident)}</p>

      <div className="incident-card-foot">
        <p className="incident-card-meta">
          <ClockIcon />
          <span>
            Opened {formatRelativeTime(incident.opened_at)}
            <span className="incident-card-meta-abs">
              {' '}
              · {formatPakistanTime(incident.opened_at)} {TIME_LABEL}
            </span>
            {incident.closed_at && <> · Closed {formatRelativeTime(incident.closed_at)}</>}
          </span>
        </p>

        {evidencePaths.length > 0 && (
          <div className="incident-card-evidence">
            <span className="incident-card-evidence-label">Evidence</span>
            <div className="incident-card-evidence-atts">
              {evidencePaths.map((path, index) => {
                const label = evidencePaths.length === 1 ? 'View' : `Att ${index + 1}`;
                const alt = `${title} — ${label}`;
                return (
                  <ScreenshotAttButton
                    key={`${path}-${index}`}
                    src={path}
                    label={label}
                    alt={alt}
                    onOpen={(src) => onOpenShot(src, alt)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
