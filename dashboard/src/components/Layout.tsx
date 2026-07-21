import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { nowPakistanClock, TIME_LABEL } from '../lib/time';
import type { Site } from '../lib/types';
import './layout.css';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/reports', label: 'Reporting' },
  { to: '/incidents', label: 'Incidents', badgeKey: 'incidents' as const },
  { to: '/operations', label: 'Operations' },
  { to: '/proxies', label: 'Proxies' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const [clock, setClock] = useState(nowPakistanClock());
  const [openIncidents, setOpenIncidents] = useState(0);
  const [sites, setSites] = useState<Pick<Site, 'id' | 'name' | 'main_url' | 'active'>[]>([]);
  const location = useLocation();
  const buildSha = import.meta.env.VITE_COMMIT_SHA?.slice(0, 7) || 'untracked';

  useEffect(() => {
    const t = setInterval(() => setClock(nowPakistanClock()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void supabase
      .from('incidents')
      .select('id', { count: 'exact', head: true })
      .eq('is_production', true)
      .is('closed_at', null)
      .then(({ count }) => setOpenIncidents(count || 0));
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;

    void supabase
      .from('sites')
      .select('id,name,main_url,active')
      .order('name')
      .then(({ data, error }) => {
        if (!cancelled && !error) {
          setSites((data || []) as Pick<Site, 'id' | 'name' | 'main_url' | 'active'>[]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <strong>Beacon</strong>
            <p>Live health for your quote sites</p>
          </div>
        </div>
        <nav className="nav">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
            >
              {l.label}
              {l.badgeKey === 'incidents' && openIncidents > 0 && (
                <span className="nav-badge">{openIncidents}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="clock" title="Dashboard deployed commit">
            Build {buildSha}
          </span>
          <span className="clock" title={`Pakistan time (${TIME_LABEL})`}>
            {clock} {TIME_LABEL}
          </span>
          <button
            className="signout"
            type="button"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="site-sidebar" aria-label="Monitored sites">
          <div className="site-sidebar-head">
            <div>
              <span className="eyebrow">Monitor network</span>
              <strong>Sites</strong>
            </div>
            <span className="site-count" aria-label={`${sites.length} sites`}>
              {sites.length}
            </span>
          </div>

          <nav className="site-list">
            {sites.map((site, index) => {
              let hostname = site.main_url;
              try {
                hostname = new URL(site.main_url).hostname.replace(/^www\./, '');
              } catch {
                // Keep the stored URL when it is not parseable.
              }

              return (
                <NavLink
                  key={site.id}
                  to={`/site/${site.id}`}
                  className={({ isActive }) =>
                    isActive ? 'site-link active' : 'site-link'
                  }
                >
                  <span className="site-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="site-link-copy">
                    <strong>{site.name}</strong>
                    <small>{hostname}</small>
                  </span>
                  <span
                    className={`site-state ${site.active ? 'live' : 'paused'}`}
                    title={site.active ? 'Monitoring active' : 'Monitoring paused'}
                  />
                </NavLink>
              );
            })}
            {sites.length === 0 && (
              <p className="site-list-empty">No sites available.</p>
            )}
          </nav>

          <div className="sidebar-category">
            <span className="eyebrow">Analytics</span>
            <NavLink
              to="/reports"
              className={({ isActive }) =>
                isActive ? 'reporting-sidebar-link active' : 'reporting-sidebar-link'
              }
            >
              <span className="reporting-mark" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <span>
                <strong>Reporting</strong>
                <small>1–30 day health history</small>
              </span>
              <b aria-hidden>→</b>
            </NavLink>
          </div>
        </aside>

        <main className="main">
          {import.meta.env.VITE_BEACON_ENV !== 'production' && (
            <div className="staging-banner" role="status">
              Local dashboard view — production checks run on GitHub Actions (US). Refresh after a workflow finishes to see new data.
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
