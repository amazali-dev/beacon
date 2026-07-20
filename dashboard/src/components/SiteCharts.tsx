import { useMemo } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LoadCheck } from '../lib/types';
import { formatPakistanChartTick, TIME_LABEL } from '../lib/time';

type Range = '24h' | '7d';

type Props = {
  checks: LoadCheck[];
  range: Range;
  onRangeChange: (range: Range) => void;
};

export function SiteCharts({ checks, range, onRangeChange }: Props) {
  const chartData = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>();
    for (const c of checks) {
      const key = formatPakistanChartTick(c.checked_at);
      const row = map.get(key) || { t: key };
      row[`${c.profile}_load`] = c.load_ms ?? 0;
      row[`${c.profile}_lcp`] = c.lcp_ms ?? 0;
      map.set(key, row);
    }
    return [...map.values()];
  }, [checks]);

  return (
    <div>
      <div className="toolbar">
        <div className="seg">
          <button
            type="button"
            className={range === '24h' ? 'active' : ''}
            onClick={() => onRangeChange('24h')}
          >
            Last 24h
          </button>
          <button
            type="button"
            className={range === '7d' ? 'active' : ''}
            onClick={() => onRangeChange('7d')}
          >
            Last 7 days
          </button>
        </div>
        <span className="meta">Times in {TIME_LABEL}</span>
      </div>

      <section className="chart-panel">
        <h2>Load time (ms)</h2>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3a40" />
              <XAxis dataKey="t" hide={chartData.length > 12} stroke="#8aa0a8" />
              <YAxis stroke="#8aa0a8" />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="desktop_load" name="Desktop" stroke="#3db8a0" dot={false} />
              <Line type="monotone" dataKey="webkit_load" name="Safari" stroke="#e0a45a" dot={false} />
              <Line type="monotone" dataKey="mobile_load" name="Mobile" stroke="#6aa8ff" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="chart-panel">
        <h2>Largest content load (ms)</h2>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3a40" />
              <XAxis dataKey="t" hide={chartData.length > 12} stroke="#8aa0a8" />
              <YAxis stroke="#8aa0a8" />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="desktop_lcp" name="Desktop" stroke="#3db8a0" dot={false} />
              <Line type="monotone" dataKey="webkit_lcp" name="Safari" stroke="#e0a45a" dot={false} />
              <Line type="monotone" dataKey="mobile_lcp" name="Mobile" stroke="#6aa8ff" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {chartData.length === 0 && <p className="empty">No checks in this window yet.</p>}
    </div>
  );
}
