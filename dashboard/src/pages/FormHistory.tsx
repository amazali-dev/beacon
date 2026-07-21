import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { ScreenshotModal, ScreenshotThumb } from '../components/ScreenshotModal';
import { formTestPassed, formTestSummary, formatRunLocation } from '../lib/labelMappers';
import { isRateLimitedFormTest } from '../lib/healthScoring';
import { formatPakistanTime, formatRelativeTime, TIME_LABEL } from '../lib/time';
import type { FormTest, Site } from '../lib/types';

export function FormHistory() {
  const [rows, setRows] = useState<FormTest[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteFilter, setSiteFilter] = useState('');
  const [resultFilter, setResultFilter] = useState<'all' | 'pass' | 'fail'>('all');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const [{ data: siteRows }, { data: formRows }] = await Promise.all([
        supabase.from('sites').select('id,name').order('name'),
        supabase
          .from('form_tests')
          .select('*')
          .eq('is_production', true)
          .order('tested_at', { ascending: false })
          .limit(150),
      ]);
      setSites((siteRows || []) as Site[]);
      setRows((formRows || []) as FormTest[]);
    })();
  }, []);

  const siteMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of sites) m[s.id] = s.name;
    return m;
  }, [sites]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (siteFilter && r.site_id !== siteFilter) return false;
      if (resultFilter === 'pass' && (r.outcome === 'monitor_error' || !formTestPassed(r))) return false;
      if (
        resultFilter === 'fail' &&
        (formTestPassed(r) || isRateLimitedFormTest(r) || r.outcome === 'monitor_error')
      ) return false;
      if (q && !`${r.run_id} ${r.notes || ''} ${siteMap[r.site_id] || ''}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, siteFilter, resultFilter, query, siteMap]);

  return (
    <div>
      <div className="page-head">
        <h1>Form tests</h1>
        <p>Quote form submissions across all sites. Plain-language results with screenshots.</p>
        <p className="meta form-legend">
          <strong>Submit</strong> = form filled and thank-you appeared.{" "}
          <strong>Email / Skipped</strong> = inbox verification was not assessed for that row.{" "}
          <strong>CRM / Skipped</strong> = CRM verification was not assessed for that row.
        </p>
      </div>

      <div className="filter-bar">
        <label>
          Site
          <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Result
          <select
            value={resultFilter}
            onChange={(e) => setResultFilter(e.target.value as 'all' | 'pass' | 'fail')}
          >
            <option value="all">All</option>
            <option value="pass">Passed</option>
            <option value="fail">Failed</option>
          </select>
        </label>
        <label>
          Search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Run ID, notes, site…"
          />
        </label>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Site</th>
              <th>Run ID</th>
              <th>Accessed from</th>
              <th>Result</th>
              <th>Notes</th>
              <th>Screenshot</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>
                  {formatRelativeTime(r.tested_at)}
                  <div className="meta">{formatPakistanTime(r.tested_at)} {TIME_LABEL}</div>
                </td>
                <td>
                  <Link to={`/site/${r.site_id}?tab=forms`}>
                    {siteMap[r.site_id] || r.site_id.slice(0, 8)}
                  </Link>
                </td>
                <td>
                  <code>{r.run_id}</code>
                </td>
                <td className="notes-cell">{formatRunLocation(r)}</td>
                <td>
                  <span className={`badge ${formTestPassed(r) ? 'ok' : r.layer1_pass === false ? 'bad' : 'muted'}`}>
                    {formTestSummary(r)}
                  </span>
                </td>
                <td className="notes-cell">{r.notes || '—'}</td>
                <td>
                  <ScreenshotThumb
                    src={r.screenshot_path}
                    alt={r.run_id}
                    onOpen={(src) => setModal({ src, alt: r.run_id })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && <p className="empty">No form tests match your filters.</p>}

      <ScreenshotModal
        src={modal?.src ?? null}
        alt={modal?.alt}
        onClose={() => setModal(null)}
      />
    </div>
  );
}
