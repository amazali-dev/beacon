import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { nowPakistanClock, TIME_LABEL } from '../lib/time';
import './layout.css';

const links = [
  { to: '/', label: 'Overview', end: true },
  { to: '/incidents', label: 'Incidents', badgeKey: 'incidents' as const },
  { to: '/operations', label: 'Operations' },
  { to: '/settings', label: 'Sites' },
];

export function Layout() {
  const [clock, setClock] = useState(nowPakistanClock());
  const [openIncidents, setOpenIncidents] = useState(0);
  const location = useLocation();

  useEffect(() => {
    const t = setInterval(() => setClock(nowPakistanClock()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void supabase
      .from('incidents')
      .select('id', { count: 'exact', head: true })
      .is('closed_at', null)
      .then(({ count }) => setOpenIncidents(count || 0));
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
      <main className="main">
        {import.meta.env.VITE_BEACON_ENV !== 'production' && (
          <div className="staging-banner" role="status">
            Local dashboard view — production checks run on GitHub Actions (US). Refresh after a workflow finishes to see new data.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
