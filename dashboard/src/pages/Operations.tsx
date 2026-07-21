import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  engineOnline,
  loadBeaconSettings,
  loadOperationalAlerts,
  loadRecentJobs,
  queueAndTriggerJob,
  saveBeaconSettings,
  type BeaconSettings,
  type CheckJob,
  type JobType,
  type OperationalAlert,
} from '../lib/operations';
import {
  easternHmToPakistanHm,
  easternTimesToPakistanText,
  formatPakistanTime,
  formatRelativeTime,
  TIME_LABEL,
} from '../lib/time';

const RUN_ACTIONS: Array<{
  jobType: JobType;
  label: string;
  desc: string;
  primary?: boolean;
}> = [
  {
    jobType: 'load_check',
    label: 'Load checks',
    desc: 'Starts a US GitHub Actions load check now.',
    primary: true,
  },
  {
    jobType: 'form_test',
    label: 'Form tests',
    desc: 'Starts a US GitHub Actions form test now.',
  },
  {
    jobType: 'detect_forms',
    label: 'Detect fields',
    desc: 'Starts form-field detection on the US runner now.',
  },
  {
    jobType: 'daily_report',
    label: 'Daily report',
    desc: 'Starts the daily report job on GitHub Actions now.',
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
  const [engineCommitSha, setEngineCommitSha] = useState<string | null>(null);
  const [jobs, setJobs] = useState<CheckJob[]>([]);
  const [operationalAlerts, setOperationalAlerts] = useState<OperationalAlert[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runningJob, setRunningJob] = useState<JobType | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [
        { settings: s, heartbeat: hb, engineMode: mode, lastLoadCompletedAt, engineCommitSha: sha },
        recent,
        alerts,
      ] = await Promise.all([loadBeaconSettings(), loadRecentJobs(), loadOperationalAlerts()]);
      setSettings(s);
      setHeartbeat(lastLoadCompletedAt || hb);
      setEngineMode(mode);
      setEngineCommitSha(sha);
      setJobs(recent);
      setOperationalAlerts(alerts);
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
      setMessage('Settings saved.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function runNow(jobType: JobType, label: string) {
    setMessage(null);
    setError(null);
    setRunningJob(jobType);
    try {
      await queueAndTriggerJob(jobType);
      setMessage(
        `"${label}" queued on GitHub Actions. Status below updates as it runs — results appear on Dashboard when done.`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start job');
    } finally {
      setRunningJob(null);
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
          Production runs on <strong>GitHub Actions</strong> (US). Times shown in {TIME_LABEL}.
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      {message && <p className="ok-msg">{message}</p>}

      {operationalAlerts.length > 0 && (
        <section className="ops-panel">
          <h2>Scheduling alerts</h2>
          {operationalAlerts.map((alert) => (
            <div className="engine-status offline" key={alert.key}>
              <span className="dot" />
              <div>
                <strong>{alert.key.replaceAll('_', ' ')}</strong>
                <p className="meta">
                  {alert.detail} Opened {formatRelativeTime(alert.opened_at)}.
                </p>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="ops-panel">
        <h2>Engine (GitHub Actions)</h2>
        <div className={`engine-status ${online ? 'online' : 'offline'}`}>
          <span className="dot" />
          <div>
            <strong>{online ? 'Last US run received' : 'No recent US run'}</strong>
            <p className="meta">
              {online
                ? `Last completed load run ${formatPakistanTime(heartbeat)} ${TIME_LABEL} (${formatRelativeTime(heartbeat)}) · ${engineMode || 'production'}${engineCommitSha ? ` · ${engineCommitSha.slice(0, 7)}` : ''}`
                : 'Use Run now below, or wait for the next scheduled load check (~every 30 min).'}
            </p>
          </div>
        </div>
      </section>

      <section className="ops-panel">
        <h2>Production schedule (automatic)</h2>
        <ul className="schedule-readonly">
          <li>
            <strong>Load checks</strong> — every {settings?.loadCheckIntervalMinutes || 30} minutes
          </li>
          <li>
            <strong>Form tests</strong> — {settings?.formTestTimesEastern.join(', ') || 'not configured'} US Eastern
            {settings ? ` (≈ ${formTimesPkt} ${TIME_LABEL})` : ''}
          </li>
          <li>
            <strong>Daily report</strong> — {settings?.dailyReportTimeEastern || 'not configured'} US Eastern
            {settings ? ` (≈ ${reportPkt} ${TIME_LABEL})` : ''}
          </li>
        </ul>
      </section>

      <section className="ops-panel">
        <h2>Run now</h2>
        <p className="section-hint">
          One click securely queues the job through the server and starts GitHub Actions.
        </p>
        <div className="action-grid">
          {RUN_ACTIONS.map((a) => (
            <button
              key={a.jobType}
              type="button"
              className={`action-card ${a.primary ? 'primary' : ''}`}
              disabled={runningJob !== null}
              onClick={() => void runNow(a.jobType, a.label)}
            >
              <strong>{runningJob === a.jobType ? 'Starting…' : a.label}</strong>
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
        <h2>Recent Run now jobs</h2>
        <p className="section-hint">
          pending → running → done. When done, new rows show on Dashboard / Timeline.
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
                  No queued jobs yet.
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
                <td>
                  {j.notes ||
                    (j.status === 'pending' ? 'Queued — waiting for GitHub runner' : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
