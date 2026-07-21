import { useMemo, useState } from 'react';
import type { FormTest, Incident, LoadCheck } from '../lib/types';
import {
  formTestSummary,
  formatRunLocation,
  incidentDetailPlain,
  incidentTypeLabel,
  profileLabel,
} from '../lib/labelMappers';
import { isRateLimitedFormTest } from '../lib/healthScoring';
import { formatPakistanTime, formatRelativeTime, sinceDays, TIME_LABEL } from '../lib/time';
import { ScreenshotThumb } from './ScreenshotModal';

export type TimelineEventType = 'load' | 'form' | 'incident';

export type TimelineEvent = {
  id: string;
  type: TimelineEventType;
  timestamp: string;
  title: string;
  detail: string;
  location: string | null;
  status: 'ok' | 'bad' | 'muted';
  rateLimited: boolean;
  screenshot_path: string | null;
};

type Timeframe = '24h' | '7d' | '30d' | 'all';

type Props = {
  loadChecks: LoadCheck[];
  formTests: FormTest[];
  incidents: Incident[];
  onOpenScreenshot: (src: string, alt: string) => void;
};

function buildEvents(
  loadChecks: LoadCheck[],
  formTests: FormTest[],
  incidents: Incident[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const c of loadChecks) {
    const slow = (c.load_ms ?? 0) > 8000;
    const rateLimited = c.status_code === 429;
    const bad =
      (!c.loaded || (c.status_code ?? 0) >= 400) && !rateLimited;
    const warn =
      rateLimited ||
      c.elements_ok?.cta === false ||
      c.elements_ok?.quote_form === false ||
      slow;
    events.push({
      id: `load-${c.id}`,
      type: 'load',
      timestamp: c.checked_at,
      title: `Load check · ${profileLabel(c.profile)}`,
      detail: bad
        ? `Failed to load (${c.status_code ?? 'no status'})`
        : rateLimited
          ? `Site rate-limited checker (HTTP ${c.status_code})`
          : warn
            ? `Loaded in ${c.load_ms ?? '?'}ms — check CTA/form or speed`
            : `Loaded in ${c.load_ms ?? '?'}ms`,
      location: formatRunLocation(c),
      status: bad ? 'bad' : warn ? 'muted' : 'ok',
      rateLimited,
      screenshot_path: c.screenshot_path,
    });
  }

  for (const f of formTests) {
    const rateLimited = isRateLimitedFormTest(f);
    const failed = !rateLimited && (f.layer1_pass === false || f.layer2_pass === false);
    events.push({
      id: `form-${f.id}`,
      type: 'form',
      timestamp: f.tested_at,
      title: `Form test · ${f.run_id}`,
      detail: f.notes ? `${formTestSummary(f)} — ${f.notes}` : formTestSummary(f),
      location: formatRunLocation(f),
      status: failed ? 'bad' : f.layer1_pass === true ? 'ok' : 'muted',
      rateLimited,
      screenshot_path: f.screenshot_path,
    });
  }

  for (const i of incidents) {
    events.push({
      id: `incident-open-${i.id}`,
      type: 'incident',
      timestamp: i.opened_at,
      title: `${incidentTypeLabel(i.type)} opened`,
      detail: incidentDetailPlain(i),
      location: null,
      status: i.closed_at ? 'muted' : 'bad',
      rateLimited: i.type === 'rate_limited',
      screenshot_path: i.screenshot_path,
    });
    if (i.closed_at) {
      events.push({
        id: `incident-close-${i.id}`,
        type: 'incident',
        timestamp: i.closed_at,
        title: `${incidentTypeLabel(i.type)} resolved`,
        detail: incidentDetailPlain(i),
        location: null,
        status: 'ok',
        rateLimited: i.type === 'rate_limited',
        screenshot_path: i.screenshot_path,
      });
    }
  }

  return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function Timeline({ loadChecks, formTests, incidents, onOpenScreenshot }: Props) {
  const [types, setTypes] = useState<Set<TimelineEventType>>(
    () => new Set(['load', 'form', 'incident'])
  );
  const [timeframe, setTimeframe] = useState<Timeframe>('7d');
  const [query, setQuery] = useState('');
  const [rateLimitedOnly, setRateLimitedOnly] = useState(false);

  const allEvents = useMemo(
    () => buildEvents(loadChecks, formTests, incidents),
    [loadChecks, formTests, incidents]
  );

  const filtered = useMemo(() => {
    const since =
      timeframe === '24h'
        ? sinceDays(1 / 24)
        : timeframe === '7d'
          ? sinceDays(7)
          : timeframe === '30d'
            ? sinceDays(30)
            : null;
    const q = query.trim().toLowerCase();

    return allEvents.filter((e) => {
      if (!types.has(e.type)) return false;
      if (rateLimitedOnly ? !e.rateLimited : e.rateLimited) return false;
      if (since && e.timestamp < since) return false;
      if (q && !`${e.title} ${e.detail} ${e.location || ''}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [allEvents, types, timeframe, query, rateLimitedOnly]);

  function toggleType(t: TimelineEventType) {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <div className="timeline-wrap">
      <div className="filter-bar">
        <label>
          Search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by keyword…"
          />
        </label>
        <label>
          Timeframe
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            <option value="24h">Last 24h</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <div className="chip-group">
          {(['load', 'form', 'incident'] as TimelineEventType[]).map((t) => (
            <button
              key={t}
              type="button"
              className={types.has(t) ? 'chip active' : 'chip'}
              onClick={() => toggleType(t)}
            >
              {t === 'load' ? 'Load' : t === 'form' ? 'Forms' : 'Incidents'}
            </button>
          ))}
        </div>
        <label className="filter-checkbox">
          <input
            type="checkbox"
            checked={rateLimitedOnly}
            onChange={(event) => setRateLimitedOnly(event.target.checked)}
          />
          Rate limited only
        </label>
      </div>

      <ol className="timeline-list">
        {filtered.map((e) => (
          <li key={e.id} className={`timeline-item status-${e.status}`}>
            <div className="timeline-marker" />
            <div className="timeline-body">
              <header>
                <strong>{e.title}</strong>
                <span className={`badge ${e.status === 'ok' ? 'ok' : e.status === 'bad' ? 'bad' : 'muted'}`}>
                  {e.type}
                </span>
              </header>
              <p className="meta">
                {formatRelativeTime(e.timestamp)} · {formatPakistanTime(e.timestamp)} {TIME_LABEL}
              </p>
              {e.location && <p className="run-location">Accessed from: {e.location}</p>}
              <p>{e.detail}</p>
              <ScreenshotThumb
                src={e.screenshot_path}
                alt={e.title}
                onOpen={(src) => onOpenScreenshot(src, e.title)}
              />
            </div>
          </li>
        ))}
      </ol>
      {filtered.length === 0 && (
        <p className="empty">No events match your filters.</p>
      )}
    </div>
  );
}
