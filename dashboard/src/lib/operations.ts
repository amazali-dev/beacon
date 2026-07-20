import { supabase } from './supabase';

export type BeaconSettings = {
  loadCheckIntervalMinutes: number;
  formTestTimesEastern: string[];
  dailyReportTimeEastern: string;
  loadTimeThresholdMs: number;
  alertCooldownHours: number;
  formLayer1TimeoutSeconds: number;
  formLayer2TimeoutMinutes: number;
  skipAlertsInStaging: boolean;
  stagingLabel: string;
};

export type CheckJob = {
  id: string;
  job_type: string;
  status: string;
  requested_at: string;
  completed_at: string | null;
  notes: string | null;
};

const DEFAULTS: BeaconSettings = {
  loadCheckIntervalMinutes: 30,
  formTestTimesEastern: ['00:00', '06:00', '12:00', '18:00'],
  dailyReportTimeEastern: '23:30',
  loadTimeThresholdMs: 8000,
  alertCooldownHours: 2,
  formLayer1TimeoutSeconds: 15,
  formLayer2TimeoutMinutes: 10,
  skipAlertsInStaging: true,
  stagingLabel: 'Pakistan staging',
};

function parseValue(key: string, raw: unknown): unknown {
  if (raw === null || raw === undefined) return DEFAULTS[key as keyof BeaconSettings];
  if (typeof raw === 'string' && raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function loadBeaconSettings(): Promise<{
  settings: BeaconSettings;
  heartbeat: string | null;
  engineMode: string | null;
}> {
  const { data, error } = await supabase.from('app_settings').select('key,value');
  if (error) throw new Error(error.message);

  const map = new Map((data || []).map((r) => [r.key, r.value]));
  const settings = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS) as (keyof BeaconSettings)[]) {
    if (map.has(key)) {
      const v = parseValue(key, map.get(key));
      (settings as Record<string, unknown>)[key] = v;
    }
  }

  const heartbeat = (map.get('engine_heartbeat') as string) || null;
  const engineMode = (map.get('engine_mode') as string) || null;

  return { settings, heartbeat, engineMode };
}

export async function saveBeaconSettings(settings: BeaconSettings): Promise<void> {
  const rows = Object.entries(settings).map(([key, value]) => ({
    key,
    value,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('app_settings').upsert(rows);
  if (error) throw new Error(error.message);
}

export async function queueJob(
  jobType: 'load_check' | 'form_test' | 'detect_forms' | 'daily_report'
): Promise<void> {
  const { error } = await supabase.from('check_jobs').insert({ job_type: jobType });
  if (error) throw new Error(error.message);
}

export async function loadRecentJobs(): Promise<CheckJob[]> {
  const { data, error } = await supabase
    .from('check_jobs')
    .select('id,job_type,status,requested_at,completed_at,notes')
    .order('requested_at', { ascending: false })
    .limit(15);
  if (error) throw new Error(error.message);
  return (data || []) as CheckJob[];
}

export function engineOnline(heartbeat: string | null): boolean {
  if (!heartbeat) return false;
  return Date.now() - new Date(heartbeat).getTime() < 3 * 60 * 1000;
}
