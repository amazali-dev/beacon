/**
 * Settings and job queue — controlled from the Beacon dashboard.
 */

import { getEnv, loadConfig, setRuntimeConfig } from '../config.js';
import { getSupabase } from './supabase.js';
import type { EngineConfig } from '../types.js';

export type RuntimeSettings = Pick<
  EngineConfig,
  | 'loadCheckIntervalMinutes'
  | 'formTestTimesEastern'
  | 'dailyReportTimeEastern'
  | 'loadTimeThresholdMs'
  | 'alertCooldownHours'
  | 'formLayer1TimeoutSeconds'
  | 'formLayer2TimeoutMinutes'
  | 'skipAlertsInStaging'
  | 'stagingLabel'
>;

const SETTING_KEYS = [
  'loadCheckIntervalMinutes',
  'formTestTimesEastern',
  'dailyReportTimeEastern',
  'loadTimeThresholdMs',
  'alertCooldownHours',
  'formLayer1TimeoutSeconds',
  'formLayer2TimeoutMinutes',
  'skipAlertsInStaging',
  'stagingLabel',
] as const;

function defaults(): RuntimeSettings {
  const c = loadConfig();
  return {
    loadCheckIntervalMinutes: c.loadCheckIntervalMinutes,
    formTestTimesEastern: c.formTestTimesEastern,
    dailyReportTimeEastern: c.dailyReportTimeEastern,
    loadTimeThresholdMs: c.loadTimeThresholdMs,
    alertCooldownHours: c.alertCooldownHours,
    formLayer1TimeoutSeconds: c.formLayer1TimeoutSeconds,
    formLayer2TimeoutMinutes: c.formLayer2TimeoutMinutes,
    skipAlertsInStaging: c.skipAlertsInStaging,
    stagingLabel: c.stagingLabel,
  };
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettings> {
  const base = defaults();
  try {
    const { data, error } = await getSupabase().from('app_settings').select('key,value');
    if (error || !data?.length) return base;

    const map = new Map(data.map((r) => [r.key, r.value]));
    return {
      loadCheckIntervalMinutes:
        Number(map.get('loadCheckIntervalMinutes')) || base.loadCheckIntervalMinutes,
      formTestTimesEastern:
        (map.get('formTestTimesEastern') as string[]) || base.formTestTimesEastern,
      dailyReportTimeEastern:
        (map.get('dailyReportTimeEastern') as string) || base.dailyReportTimeEastern,
      loadTimeThresholdMs: Number(map.get('loadTimeThresholdMs')) || base.loadTimeThresholdMs,
      alertCooldownHours: Number(map.get('alertCooldownHours')) || base.alertCooldownHours,
      formLayer1TimeoutSeconds:
        Number(map.get('formLayer1TimeoutSeconds')) || base.formLayer1TimeoutSeconds,
      formLayer2TimeoutMinutes:
        Number(map.get('formLayer2TimeoutMinutes')) || base.formLayer2TimeoutMinutes,
      skipAlertsInStaging:
        map.get('skipAlertsInStaging') !== undefined
          ? Boolean(map.get('skipAlertsInStaging'))
          : base.skipAlertsInStaging,
      stagingLabel: (map.get('stagingLabel') as string) || base.stagingLabel,
    };
  } catch {
    return base;
  }
}

export async function hydrateRuntimeSettings(): Promise<RuntimeSettings> {
  const settings = await fetchRuntimeSettings();
  setRuntimeConfig(settings);
  return settings;
}

export async function touchEngineHeartbeat(
  mode: string,
  geo?: { country: string | null; ip: string | null; isUs: boolean }
): Promise<void> {
  const now = new Date().toISOString();
  const rows: Array<{ key: string; value: unknown }> = [
    { key: 'engine_heartbeat', value: now },
    { key: 'engine_mode', value: mode },
  ];

  if (geo) {
    const country = (geo.country || 'unknown').toUpperCase();
    const place = geo.isUs
      ? `United States (${country})`
      : country === 'UNKNOWN'
        ? 'Unknown location'
        : `Outside US (${country})`;
    rows.push(
      { key: 'engine_geo_country', value: country },
      { key: 'engine_geo_ip', value: geo.ip || null },
      { key: 'engine_geo_label', value: place },
      {
        key: 'engine_geo_source',
        value: mode === 'production' ? 'GitHub Actions' : 'Local test',
      }
    );
  }

  await getSupabase().from('app_settings').upsert(rows);
}


export type CheckJobType = 'load_check' | 'form_test' | 'detect_forms' | 'daily_report';

export async function claimNextJob(): Promise<{
  id: string;
  job_type: CheckJobType;
  site_id: string | null;
  cancel_requested_at: string | null;
} | null> {
  const runnerId =
    getEnv('GITHUB_RUN_ID') || `local-${process.pid}-${Date.now().toString(36)}`;
  const { data, error } = await getSupabase().rpc('claim_next_check_job', {
    p_runner_id: runnerId,
    p_lease_minutes: 65,
  });
  if (error) throw new Error(`Could not claim queued job: ${error.message}`);
  if (!data) return null;

  // Support both the jsonb RPC payload and older composite-row responses.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const job = row as {
    id?: string | null;
    job_type?: CheckJobType | null;
    site_id?: string | null;
    cancel_requested_at?: string | null;
  };
  // PostgREST composite RETURNS can serialize SQL NULL as { id: null, ... }.
  if (!job.id || !job.job_type) {
    return null;
  }

  const githubRunId = getEnv('GITHUB_RUN_ID');
  if (githubRunId) {
    const { error: runErr } = await getSupabase()
      .from('check_jobs')
      .update({ github_run_id: githubRunId })
      .eq('id', job.id);
    if (runErr) {
      console.warn(`Could not store github_run_id for job ${job.id}: ${runErr.message}`);
    }
  }

  return {
    id: job.id,
    job_type: job.job_type,
    site_id: job.site_id ?? null,
    cancel_requested_at: job.cancel_requested_at ?? null,
  };
}

export async function finishJob(
  id: string,
  ok: boolean,
  notes?: string,
  opts?: { cancelled?: boolean }
): Promise<void> {
  const status = opts?.cancelled ? 'cancelled' : ok ? 'done' : 'failed';
  const { error } = await getSupabase()
    .from('check_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      notes: notes || null,
      lease_expires_at: null,
      runner_id: null,
    })
    .eq('id', id);
  if (error) throw new Error(`Could not finish queued job: ${error.message}`);
}

export async function startMonitorRun(input: {
  runKey: string;
  jobType: string;
  isProduction: boolean;
  country: string | null;
  ip: string | null;
  expectedChecks?: number;
}): Promise<void> {
  const { error } = await getSupabase().from('monitor_runs').upsert(
    {
      run_key: input.runKey,
      job_type: input.jobType,
      status: 'running',
      is_production: input.isProduction,
      country: input.country,
      ip: input.ip,
      expected_checks: input.expectedChecks ?? null,
      completed_checks: 0,
      started_at: new Date().toISOString(),
      completed_at: null,
      commit_sha: getEnv('GITHUB_SHA') || null,
      workflow_run_id: getEnv('GITHUB_RUN_ID') || null,
    },
    { onConflict: 'run_key' }
  );
  if (error) throw new Error(`Could not start monitor run: ${error.message}`);
}

export async function finishMonitorRun(
  runKey: string,
  status: 'completed' | 'partial' | 'failed' | 'skipped',
  completedChecks: number,
  detail?: string
): Promise<void> {
  const { error } = await getSupabase()
    .from('monitor_runs')
    .update({
      status,
      completed_checks: completedChecks,
      completed_at: new Date().toISOString(),
      detail: detail || null,
    })
    .eq('run_key', runKey);
  if (error) throw new Error(`Could not finish monitor run: ${error.message}`);
}

export async function runRetention(): Promise<void> {
  const { error } = await getSupabase().rpc('cleanup_old_monitoring_data');
  if (error) throw new Error(`Retention cleanup failed: ${error.message}`);
}
