import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  engineOnline,
  loadBeaconSettings,
  loadRecentJobs,
  queueAndTriggerJob,
  saveBeaconSettings,
  saveGithubDispatchToken,
  type BeaconSettings,
  type CheckJob,
  type JobType,
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
  const [hasGithubToken, setHasGithubToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [jobs, setJobs] = useState<CheckJob[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runningJob, setRunningJob] = useState<JobType | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [{ settings: s, heartbeat: hb, engineMode: mode, hasGithubToken: tok }, recent] =
        await Promise.all([loadBeaconSettings(), loadRecentJobs()]);
      setSettings(s);
      setHeartbeat(hb);
      setEngineMode(mode);
      setHasGithubToken(tok);
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
      if (tokenDraft.trim()) {
        await saveGithubDispatchToken(tokenDraft);
        setTokenDraft('');
        setHasGithubToken(true);
      }
      setMessage('Settings saved.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function onSaveTokenOnly(e: FormEvent) {
    e.preventDefault();
    if (!tokenDraft.trim()) {
      setError('Paste your GitHub fine-grained PAT first.');
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await saveGithubDispatchToken(tokenDraft);
      setTokenDraft('');
      setHasGithubToken(true);
      setMessage('GitHub token saved. Run now buttons will start Actions immediately.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save token');
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
        `"${label}" started on GitHub Actions (US). Status below updates as it runs — results appear on Overview when done.`
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

      <section className="ops-panel">
        <h2>Engine (GitHub Actions)</h2>
        <div className={`engine-status ${online ? 'online' : 'offline'}`}>
          <span className="dot" />
          <div>
            <strong>{online ? 'Last US run received' : 'No recent US run'}</strong>
            <p className="meta">
              {online
                ? `Heartbeat ${formatPakistanTime(heartbeat)} ${TIME_LABEL} (${formatRelativeTime(heartbeat)}) · ${engineMode || 'production'}`
                : 'Use Run now below, or wait for the next scheduled load check (~every 30 min).'}
            </p>
          </div>
        </div>
      </section>

      {!hasGithubToken && (
        <section className="ops-panel">
          <h2>One-time setup — GitHub token</h2>
          <p className="section-hint">
            Same fine-grained PAT you used for cron-job.org: <strong>Actions: Read and write</strong>,{' '}
            <strong>Contents: Read</strong>, repo <code>amazali-dev/beacon</code>. This lets Run now
            start the workflow when you click (no GitHub tab).
          </p>
          <form className="settings-form" onSubmit={onSaveTokenOnly}>
            <label>
              GitHub fine-grained PAT
              <input
                type="password"
                autoComplete="off"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="github_pat_…"
              />
            </label>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save token'}
            </button>
          </form>
        </section>
      )}

      <section className="ops-panel">
        <h2>Production schedule (automatic)</h2>
        <ul className="schedule-readonly">
          <li>
            <strong>Load checks</strong> — every 30 minutes
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
      </section>

      <section className="ops-panel">
        <h2>Run now</h2>
        <p className="section-hint">
          One click queues the job and starts GitHub Actions on a US runner.
          {!hasGithubToken && ' Save the GitHub token above first.'}
        </p>
        <div className="action-grid">
          {RUN_ACTIONS.map((a) => (
            <button
              key={a.jobType}
              type="button"
              className={`action-card ${a.primary ? 'primary' : ''}`}
              disabled={!hasGithubToken || runningJob !== null}
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
              <label>
                Replace GitHub Run now token (optional)
                <input
                  type="password"
                  autoComplete="off"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  placeholder={hasGithubToken ? '•••••••• (leave blank to keep)' : 'github_pat_…'}
                />
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
          pending → running → done. When done, new rows show on Overview / Timeline.
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
