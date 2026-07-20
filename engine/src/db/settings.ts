/**
 * Settings and job queue — controlled from the Beacon dashboard.
 */

import { loadConfig } from '../config.js';
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

export async function touchEngineHeartbeat(mode: string): Promise<void> {
  const now = new Date().toISOString();
  await getSupabase().from('app_settings').upsert([
    { key: 'engine_heartbeat', value: now },
    { key: 'engine_mode', value: mode },
  ]);
}

export type CheckJobType = 'load_check' | 'form_test' | 'detect_forms' | 'daily_report';

export async function claimNextJob(): Promise<{
  id: string;
  job_type: CheckJobType;
} | null> {
  const { data: pending } = await getSupabase()
    .from('check_jobs')
    .select('id,job_type')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  const { data: claimed } = await getSupabase()
    .from('check_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', pending.id)
    .eq('status', 'pending')
    .select('id,job_type')
    .maybeSingle();

  return claimed as { id: string; job_type: CheckJobType } | null;
}

export async function finishJob(
  id: string,
  ok: boolean,
  notes?: string
): Promise<void> {
  await getSupabase()
    .from('check_jobs')
    .update({
      status: ok ? 'done' : 'failed',
      completed_at: new Date().toISOString(),
      notes: notes || null,
    })
    .eq('id', id);
}
