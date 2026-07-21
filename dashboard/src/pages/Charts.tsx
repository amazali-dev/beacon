import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SiteCharts } from '../components/SiteCharts';
import { supabase } from '../lib/supabase';
import { sinceDays } from '../lib/time';
import type { LoadCheck, Site } from '../lib/types';

type Range = '24h' | '7d';

export function Charts() {
  const [params, setParams] = useSearchParams();
  const [sites, setSites] = useState<Site[]>([]);
  const [checks, setChecks] = useState<LoadCheck[]>([]);
  const [range, setRange] = useState<Range>('24h');
  const siteId = params.get('site') || '';

  useEffect(() => {
    void supabase
      .from('sites')
      .select('id,name')
      .order('name')
      .then(({ data }) => {
        const rows = (data || []) as Site[];
        setSites(rows);
        if (!siteId && rows[0]) {
          setParams({ site: rows[0].id });
        }
      });
  }, [siteId, setParams]);

  useEffect(() => {
    if (!siteId) return;
    const since = range === '24h' ? sinceDays(1) : sinceDays(7);
    void supabase
      .from('load_checks')
      .select('*')
      .eq('site_id', siteId)
      .eq('is_production', true)
      .gte('checked_at', since)
      .order('checked_at', { ascending: true })
      .then(({ data }) => setChecks((data || []) as LoadCheck[]));
  }, [siteId, range]);

  const siteName = sites.find((s) => s.id === siteId)?.name;

  return (
    <div>
      <div className="page-head">
        <h1>Load charts</h1>
        <p>
          Legacy charts view. For the full site experience, open{' '}
          {siteId ? (
            <Link to={`/site/${siteId}?tab=speed`}>site detail → Speed</Link>
          ) : (
            'a site from Dashboard'
          )}
          .
        </p>
      </div>
      <div className="toolbar">
        <label>
          Site
          <select
            value={siteId}
            onChange={(e) => setParams({ site: e.target.value })}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {siteId && (
          <Link className="button-link" to={`/site/${siteId}?tab=speed`}>
            Open {siteName || 'site'} detail →
          </Link>
        )}
      </div>
      <SiteCharts checks={checks} range={range} onRangeChange={setRange} />
    </div>
  );
}
