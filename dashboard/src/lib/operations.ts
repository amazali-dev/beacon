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

export type OperationalAlert = {
  key: string;
  detail: string;
  opened_at: string;
  closed_at: string | null;
  last_alerted_at: string | null;
};

export type JobType = 'load_check' | 'form_test' | 'detect_forms' | 'daily_report';

const DEFAULTS: BeaconSettings = {
  loadCheckIntervalMinutes: 60,
  formTestTimesEastern: [
    '00:00',
    '02:00',
    '04:00',
    '06:00',
    '08:00',
    '10:00',
    '12:00',
    '14:00',
    '16:00',
    '18:00',
    '20:00',
    '22:00',
  ],
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
  geoCountry: string | null;
  geoIp: string | null;
  geoLabel: string | null;
  geoSource: string | null;
  hasGithubToken: boolean;
  lastLoadCompletedAt: string | null;
  engineCommitSha: string | null;
}> {
  const [{ data, error }, { data: latestRun }] = await Promise.all([
    supabase.from('app_settings').select('key,value'),
    supabase
      .from('monitor_runs')
      .select('completed_at,commit_sha')
      .eq('job_type', 'load_check')
      .eq('is_production', true)
      .in('status', ['completed', 'partial'])
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
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
  const geoCountry = (map.get('engine_geo_country') as string) || null;
  const geoIp = (map.get('engine_geo_ip') as string) || null;
  const geoLabel = (map.get('engine_geo_label') as string) || null;
  const geoSource = (map.get('engine_geo_source') as string) || null;
  const hasGithubToken = true;

  return {
    settings,
    heartbeat,
    engineMode,
    geoCountry,
    geoIp,
    geoLabel,
    geoSource,
    hasGithubToken,
    lastLoadCompletedAt: latestRun?.completed_at || null,
    engineCommitSha: latestRun?.commit_sha || null,
  };
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

/** Queue and dispatch through the authenticated server-side Edge Function. */
export async function queueAndTriggerJob(jobType: JobType, siteId?: string): Promise<void> {
  const { error } = await supabase.functions.invoke('dispatch-job', {
    body: { jobType, siteId: siteId || null },
  });
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

export async function loadOperationalAlerts(): Promise<OperationalAlert[]> {
  const { data, error } = await supabase
    .from('operational_alerts')
    .select('*')
    .is('closed_at', null)
    .order('opened_at', { ascending: false });
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data || []) as OperationalAlert[];
}

/**
 * Engine is "online" if GitHub Actions (or a local run) reported a heartbeat
 * within the last 90 minutes. Load checks run every 30 minutes, so a 3-minute
 * window would always look offline on GitHub Actions.
 */
export function engineOnline(heartbeat: string | null): boolean {
  if (!heartbeat) return false;
  return Date.now() - new Date(heartbeat).getTime() < 90 * 60 * 1000;
}
