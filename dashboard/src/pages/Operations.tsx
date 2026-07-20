import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  engineOnline,
  loadBeaconSettings,
  loadRecentJobs,
  queueJob,
  saveBeaconSettings,
  type BeaconSettings,
  type CheckJob,
} from '../lib/operations';
import {
  easternHmToPakistanHm,
  easternTimesToPakistanText,
  formatPakistanTime,
  pakistanHmToEasternHm,
  pakistanTimesTextToEastern,
  TIME_LABEL,
} from '../lib/time';

const RUN_ACTIONS = [
  {
    jobType: 'load_check' as const,
    label: 'Load checks',
    desc: 'Check all 5 sites on desktop, Safari, and mobile.',
    primary: true,
  },
  {
    jobType: 'form_test' as const,
    label: 'Form tests',
    desc: 'Fill quote forms, submit, and capture thank-you screens.',
  },
  {
    jobType: 'detect_forms' as const,
    label: 'Detect fields',
    desc: 'Auto-find name, email, phone, and upload fields.',
  },
  {
    jobType: 'daily_report' as const,
    label: 'Daily report',
    desc: 'Send the summary email now (if SMTP is configured).',
  },
];

const JOB_LABELS: Record<string, string> = {
  load_check: 'Load checks',
  form_test: 'Form tests',
  detect_forms: 'Field detection',
  daily_report: 'Daily report',
};

export function Operations() {
  const [settings, setSettings] = useState<BeaconSettings | null>(null);
  const [formTimesText, setFormTimesText] = useState('');
  const [reportTimePkt, setReportTimePkt] = useState('');
  const [heartbeat, setHeartbeat] = useState<string | null>(null);
  const [engineMode, setEngineMode] = useState<string | null>(null);
  const [jobs, setJobs] = useState<CheckJob[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ settings: s, heartbeat: hb, engineMode: mode }, recent] = await Promise.all([
        loadBeaconSettings(),
        loadRecentJobs(),
      ]);
      setSettings(s);
      setFormTimesText(easternTimesToPakistanText(s.formTestTimesEastern));
      setReportTimePkt(easternHmToPakistanHm(s.dailyReportTimeEastern));
      setHeartbeat(hb);
      setEngineMode(mode);
      setJobs(recent);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load operations data');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    try {
      const formTestTimesEastern = pakistanTimesTextToEastern(formTimesText);
      const dailyReportTimeEastern = pakistanHmToEasternHm(reportTimePkt);
      await saveBeaconSettings({ ...settings, formTestTimesEastern, dailyReportTimeEastern });
      setMessage('Schedule saved. The engine picks this up within about a minute.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function runNow(
    jobType: 'load_check' | 'form_test' | 'detect_forms' | 'daily_report',
    label: string
  ) {
    setMessage(null);
    setError(null);
    try {
      await queueJob(jobType);
      setMessage(
        `"${label}" queued in Supabase. For production, use GitHub Actions → Load checks → Run workflow (local queue only works if npm start is running).`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue job');
    }
  }

  const online = engineOnline(heartbeat);
  const formScheduleHint = settings
    ? `${settings.formTestTimesEastern.length} runs per day · every 6 hours`
    : '';

  return (
    <div>
      <div className="page-head">
        <h1>Operations</h1>
        <p>Run checks now, watch the engine, and tune the schedule. All times in {TIME_LABEL}.</p>
      </div>

      {error && <p className="error">{error}</p>}
      {message && <p className="ok-msg">{message}</p>}

      <section className="ops-panel">
        <h2>Engine</h2>
        <div className={`engine-status ${online ? 'online' : 'offline'}`}>
          <span className="dot" />
          <div>
            <strong>{online ? 'Engine running' : 'Engine not detected'}</strong>
            <p className="meta">
              {online
                ? `Last seen ${formatPakistanTime(heartbeat)} ${TIME_LABEL} · ${engineMode || 'production'} mode`
                : 'No recent GitHub Actions heartbeat yet — run Load checks once from the Actions tab.'}
            </p>
          </div>
        </div>
      </section>

      <section className="ops-panel">
        <h2>Run now</h2>
        <p className="section-hint">Instant tests — no need to wait for the schedule.</p>
        <div className="action-grid">
          {RUN_ACTIONS.map((a) => (
            <button
              key={a.jobType}
              type="button"
              className={`action-card ${a.primary ? 'primary' : ''}`}
              onClick={() => void runNow(a.jobType, a.label)}
            >
              <strong>{a.label}</strong>
              <span>{a.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {settings && (
        <form className="ops-panel settings-form ops-schedule" onSubmit={onSave}>
          <h2>Schedule</h2>
          <p className="section-hint">
            Automatic runs while the engine is open. {formScheduleHint}
          </p>

          <label>
            Load check interval (minutes)
            <input
              type="number"
              min={5}
              max={120}
              value={settings.loadCheckIntervalMinutes}
              onChange={(e) =>
                setSettings({ ...settings, loadCheckIntervalMinutes: Number(e.target.value) })
              }
            />
            <span className="field-hint">Default: every 30 minutes</span>
          </label>

          <label>
            Form test times ({TIME_LABEL}, comma-separated HH:MM)
            <input
              value={formTimesText}
              onChange={(e) => setFormTimesText(e.target.value)}
              placeholder="09:00, 15:00, 21:00, 03:00"
            />
            <span className="field-hint">4 times per day, 6 hours apart</span>
          </label>

          <label>
            Daily report time ({TIME_LABEL} HH:MM)
            <input
              value={reportTimePkt}
              onChange={(e) => setReportTimePkt(e.target.value)}
              placeholder="08:30"
            />
          </label>

          <button
            type="button"
            className="linkish advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? 'Hide advanced settings ▲' : 'Show advanced settings ▼'}
          </button>

          {showAdvanced && (
            <>
              <label>
                Slow load alert threshold (ms)
                <input
                  type="number"
                  min={3000}
                  step={500}
                  value={settings.loadTimeThresholdMs}
                  onChange={(e) =>
                    setSettings({ ...settings, loadTimeThresholdMs: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Alert cooldown (hours)
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={settings.alertCooldownHours}
                  onChange={(e) =>
                    setSettings({ ...settings, alertCooldownHours: Number(e.target.value) })
                  }
                />
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={settings.skipAlertsInStaging}
                  onChange={(e) =>
                    setSettings({ ...settings, skipAlertsInStaging: e.target.checked })
                  }
                />
                Skip email alerts during staging
              </label>
            </>
          )}

          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save schedule'}
          </button>
        </form>
      )}

      <section className="ops-panel table-wrap">
        <h2>Recent jobs</h2>
        <table>
          <thead>
            <tr>
              <th>When ({TIME_LABEL})</th>
              <th>Job</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{formatPakistanTime(j.requested_at)}</td>
                <td>{JOB_LABELS[j.job_type] || j.job_type}</td>
                <td>
                  <span className={`badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'muted'}`}>
                    {j.status}
                  </span>
                </td>
                <td>{j.notes || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {jobs.length === 0 && <p className="empty">No jobs yet — use Run now above.</p>}
      </section>
    </div>
  );
}
