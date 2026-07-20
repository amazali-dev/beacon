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
  formatRelativeTime,
  TIME_LABEL,
} from '../lib/time';

const RUN_ACTIONS = [
  {
    jobType: 'load_check' as const,
    label: 'Load checks',
    desc: 'Queues a local job only. For US production, use GitHub Actions → Run workflow.',
    primary: true,
  },
  {
    jobType: 'form_test' as const,
    label: 'Form tests',
    desc: 'Queues a local job only. Production form tests run on GitHub on schedule.',
  },
  {
    jobType: 'detect_forms' as const,
    label: 'Detect fields',
    desc: 'Auto-find name, email, phone, and upload fields (local queue).',
  },
  {
    jobType: 'daily_report' as const,
    label: 'Daily report',
    desc: 'Queues a local report job. Production report is the GitHub daily workflow.',
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

  async function onSaveAdvanced(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    try {
      await saveBeaconSettings(settings);
      setMessage('Alert settings saved.');
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
        `"${label}" was added to Recent jobs below — but that queue only runs if a local engine is open. ` +
          `For real US checks: GitHub → Actions → Load checks → Run workflow.`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue job');
    }
  }

  const online = engineOnline(heartbeat);
  const formTimesPkt = settings
    ? easternTimesToPakistanText(settings.formTestTimesEastern)
    : '—';
  const reportPkt = settings
    ? easternHmToPakistanHm(settings.dailyReportTimeEastern)
    : '—';

  return (
    <div>
      <div className="page-head">
        <h1>Operations</h1>
        <p>
          Production runs on <strong>GitHub Actions</strong> (US). This page shows status and
          optional local queue jobs. Times shown in {TIME_LABEL}.
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      {message && <p className="ok-msg">{message}</p>}

      <section className="ops-panel">
        <h2>Engine (GitHub Actions)</h2>
        <div className={`engine-status ${online ? 'online' : 'offline'}`}>
          <span className="dot" />
          <div>
            <strong>{online ? 'Last US run received' : 'No recent US run'}</strong>
            <p className="meta">
              {online
                ? `Heartbeat ${formatPakistanTime(heartbeat)} ${TIME_LABEL} (${formatRelativeTime(heartbeat)}) · ${engineMode || 'production'}`
                : 'Open GitHub → Actions → Load checks, or wait for the next scheduled run (~every 30 min).'}
            </p>
          </div>
        </div>
      </section>

      <section className="ops-panel">
        <h2>Production schedule (GitHub — not editable here)</h2>
        <p className="section-hint">
          Changing times on this page does <strong>not</strong> change GitHub. Schedules live in
          the workflow files. To change them later, ask Cursor to edit{' '}
          <code>.github/workflows/</code>.
        </p>
        <ul className="schedule-readonly">
          <li>
            <strong>Load checks</strong> — every 30 minutes (automatic)
          </li>
          <li>
            <strong>Form tests</strong> — 00:00, 06:00, 12:00, 18:00 US Eastern
            {settings ? ` (≈ ${formTimesPkt} ${TIME_LABEL})` : ''}
          </li>
          <li>
            <strong>Daily report</strong> — 23:30 US Eastern
            {settings ? ` (≈ ${reportPkt} ${TIME_LABEL})` : ''}
          </li>
        </ul>
        <p className="field-hint">
          Watch real runs at{' '}
          <a
            href="https://github.com/amazali-dev/beacon/actions"
            target="_blank"
            rel="noreferrer"
          >
            github.com/amazali-dev/beacon/actions
          </a>
          . Scheduled runs say <strong>Scheduled</strong>, not “Manually run”.
        </p>
      </section>

      <section className="ops-panel">
        <h2>Run now (local queue only)</h2>
        <p className="section-hint">
          These buttons only write to the old job queue. They do <strong>not</strong> start GitHub
          Actions. Prefer GitHub → Actions → Run workflow for production.
        </p>
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
        <form className="ops-panel settings-form" onSubmit={onSaveAdvanced}>
          <button
            type="button"
            className="linkish advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? 'Hide alert settings ▲' : 'Show alert settings ▼'}
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
                Skip email alerts during staging / local tests
              </label>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save alert settings'}
              </button>
            </>
          )}
        </form>
      )}

      <section className="ops-panel table-wrap">
        <h2>Recent jobs (dashboard queue only)</h2>
        <p className="section-hint">
          This list is <strong>not</strong> GitHub Actions. It only shows jobs from the buttons
          above. GitHub runs appear on the Actions tab and as new rows in Overview / load_checks.
        </p>
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
            {jobs.length === 0 && (
              <tr>
                <td colSpan={4} className="meta">
                  No queued jobs yet. That is normal if you only use GitHub Actions.
                </td>
              </tr>
            )}
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{formatPakistanTime(j.requested_at)}</td>
                <td>{JOB_LABELS[j.job_type] || j.job_type}</td>
                <td>
                  <span
                    className={`badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'muted'}`}
                  >
                    {j.status}
                  </span>
                </td>
                <td>{j.notes || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
