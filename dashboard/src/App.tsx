import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { Layout } from './components/Layout';
import { supabase } from './lib/supabase';
import { Login } from './pages/Login';
import { Overview } from './pages/StatusWall';
import { Charts } from './pages/Charts';
import { FormHistory } from './pages/FormHistory';
import { HealthMethodology } from './pages/HealthMethodology';
import { IncidentsPage } from './pages/Incidents';
import { Operations } from './pages/Operations';
import { ProxySettings } from './pages/ProxySettings';
import { Reporting } from './pages/Reporting';
import { Settings } from './pages/Settings';
import { SiteDetail } from './pages/SiteDetail';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) {
    return <div className="boot">Loading…</div>;
  }

  if (!session) {
    return <Login />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="site/:siteId" element={<SiteDetail />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="operations" element={<Operations />} />
          <Route path="proxies" element={<ProxySettings />} />
          <Route path="reports" element={<Reporting />} />
          <Route path="reports/methodology" element={<HealthMethodology />} />
          <Route path="settings" element={<Settings />} />
          {/* Deep-link compatibility */}
          <Route path="charts" element={<Charts />} />
          <Route path="forms" element={<FormHistory />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
