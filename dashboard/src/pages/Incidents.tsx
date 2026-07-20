import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { ScreenshotModal, ScreenshotThumb } from '../components/ScreenshotModal';
import { incidentDetailPlain, incidentTypeLabel } from '../lib/labelMappers';
import { formatPakistanTime, formatRelativeTime, TIME_LABEL } from '../lib/time';
import type { Incident, Site } from '../lib/types';

export function IncidentsPage() {
  const [rows, setRows] = useState<Incident[]>([]);
  const [sites, setSites] = useState<Record<string, Site>>({});
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [{ data: siteRows }, { data: incidentRows }] = await Promise.all([
        supabase.from('sites').select('*'),
        supabase
          .from('incidents')
          .select('*')
          .order('opened_at', { ascending: false })
          .limit(150),
      ]);
      const map: Record<string, Site> = {};
      for (const s of (siteRows || []) as Site[]) map[s.id] = s;
      setSites(map);
      setRows((incidentRows || []) as Incident[]);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const siteName = sites[r.site_id]?.name || '';
      if (q && !`${siteName} ${r.type} ${r.detail || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, sites, query]);

  const open = filtered.filter((r) => !r.closed_at);
  const closed = filtered.filter((r) => r.closed_at);

  return (
    <div>
      <div className="page-head">
        <h1>Incidents</h1>
        <p>Open problems first — what needs your attention right now.</p>
      </div>

      <div className="filter-bar">
        <label>
          Search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Site, type, or detail…"
          />
        </label>
        <div className="summary-stat bad-stat compact">
          <strong>{open.length}</strong>
          <span>Open</span>
        </div>
      </div>

      <section className="incident-queue">
        <h2>Open ({open.length})</h2>
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
        {showClosed ? 'Hide' : 'Show'} closed incidents ({closed.length})
      </button>

      {showClosed && (
        <section className="incident-queue closed-section">
          {closed.map((r) => (
            <IncidentCard
              key={r.id}
              incident={r}
              site={sites[r.site_id]}
              onOpenShot={(src, alt) => setModal({ src, alt })}
            />
          ))}
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

function IncidentCard({
  incident,
  site,
  onOpenShot,
}: {
  incident: Incident;
  site?: Site;
  onOpenShot: (src: string, alt: string) => void;
}) {
  const open = !incident.closed_at;
  const title = incidentTypeLabel(incident.type);

  return (
    <article className={`incident ${open ? 'open' : 'closed'}`}>
      <header>
        <div>
          <strong>{site ? <Link to={`/site/${site.id}?tab=incidents`}>{site.name}</Link> : 'Site'}</strong>
          <span className="incident-type">{title}</span>
        </div>
        <span className={`badge ${open ? 'bad' : 'muted'}`}>{open ? 'Open' : 'Closed'}</span>
      </header>
      <p>{incidentDetailPlain(incident)}</p>
      <p className="meta">
        Opened {formatRelativeTime(incident.opened_at)} · {formatPakistanTime(incident.opened_at)} {TIME_LABEL}
        {incident.closed_at && (
          <> · Closed {formatRelativeTime(incident.closed_at)}</>
        )}
      </p>
      <ScreenshotThumb
        src={incident.screenshot_path}
        alt={title}
        onOpen={(src) => onOpenShot(src, title)}
      />
    </article>
  );
}
