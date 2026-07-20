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

export type JobType = 'load_check' | 'form_test' | 'detect_forms' | 'daily_report';

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

const GITHUB_REPO =
  import.meta.env.VITE_GITHUB_REPO?.trim() || 'amazali-dev/beacon';
const QUEUED_WORKFLOW = 'queued-jobs.yml';

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

function asPlainString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t || t === 'null') return null;
    if (t.startsWith('"')) {
      try {
        const parsed = JSON.parse(t);
        return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
      } catch {
        return t;
      }
    }
    return t;
  }
  return null;
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
  const geoCountry = (map.get('engine_geo_country') as string) || null;
  const geoIp = (map.get('engine_geo_ip') as string) || null;
  const geoLabel = (map.get('engine_geo_label') as string) || null;
  const geoSource = (map.get('engine_geo_source') as string) || null;
  const envToken = import.meta.env.VITE_GITHUB_DISPATCH_TOKEN?.trim() || '';
  const dbToken = asPlainString(map.get('github_dispatch_token'));
  const hasGithubToken = Boolean(envToken || dbToken);

  return {
    settings,
    heartbeat,
    engineMode,
    geoCountry,
    geoIp,
    geoLabel,
    geoSource,
    hasGithubToken,
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

/** Save the fine-grained PAT used to start GitHub Actions from Run now. */
export async function saveGithubDispatchToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) return;
  const { error } = await supabase.from('app_settings').upsert({
    key: 'github_dispatch_token',
    value: trimmed,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

async function resolveGithubToken(): Promise<string | null> {
  const fromEnv = import.meta.env.VITE_GITHUB_DISPATCH_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'github_dispatch_token')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return asPlainString(data?.value);
}

/** Tell GitHub Actions to process the dashboard job queue right now. */
export async function triggerQueuedJobsWorkflow(): Promise<void> {
  const token = await resolveGithubToken();
  if (!token) {
    throw new Error(
      'GitHub token not set. Paste your fine-grained PAT (Actions: Read and write) in the box below, then try again.'
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${QUEUED_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (res.status === 204 || res.status === 201) return;

  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'GitHub rejected the token. Use a fine-grained PAT with Actions: Read and write on amazali-dev/beacon.'
    );
  }
  if (res.status === 404) {
    throw new Error(
      'Workflow not found. Confirm the Queued jobs workflow exists on main and the PAT has Contents: Read.'
    );
  }
  throw new Error(`GitHub trigger failed (${res.status}): ${body.slice(0, 200)}`);
}

/** Queue a job and immediately start the US GitHub Actions runner. */
export async function queueAndTriggerJob(jobType: JobType): Promise<void> {
  const { error } = await supabase.from('check_jobs').insert({ job_type: jobType });
  if (error) throw new Error(error.message);
  await triggerQueuedJobsWorkflow();
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

/**
 * Engine is "online" if GitHub Actions (or a local run) reported a heartbeat
 * within the last 45 minutes. Load checks run every 30 minutes, so a 3-minute
 * window would always look offline on GitHub Actions.
 */
export function engineOnline(heartbeat: string | null): boolean {
  if (!heartbeat) return false;
  return Date.now() - new Date(heartbeat).getTime() < 45 * 60 * 1000;
}
