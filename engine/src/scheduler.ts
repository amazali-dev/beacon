/**
 * Scheduler — reads schedule from Supabase (dashboard controls it).
 * Also processes "Run now" jobs from the dashboard.
 */

import { getDeploymentMode, getStagingLabel, isStagingMode } from './config.js';
import { fetchRuntimeSettings, touchEngineHeartbeat } from './db/settings.js';
import { runGeoGuard } from './geo-guard.js';
import { processPendingJobs } from './jobs/queue.js';
import { runAllFormTests } from './modules/form-test.js';

const firedFormSlots = new Set<string>();

function nowEasternHM(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = parts.find((p) => p.type === 'hour')!.value;
  const minute = parts.find((p) => p.type === 'minute')!.value;
  return `${hour === '24' ? '00' : hour}:${minute}`;
}

function easternDateKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function schedulerTick(): Promise<void> {
  const settings = await fetchRuntimeSettings();
  const mode = getDeploymentMode();
  const geo = await runGeoGuard();
  await touchEngineHeartbeat(isStagingMode() ? 'staging' : mode, {
    country: geo.country,
    ip: geo.ip,
    isUs: geo.isUs,
  });

  await processPendingJobs();

  // Load checks disabled for now — forms only. Re-enable when needed.
  // (see .github/workflows/load-checks.yml schedule)

  const hm = nowEasternHM();
  const day = easternDateKey();
  const formKey = `${day}:${hm}`;

  if (settings.formTestTimesEastern.includes(hm) && !firedFormSlots.has(formKey)) {
    firedFormSlots.add(formKey);
    console.log('\n=== Scheduled form-test run ===');
    try {
      const geoForm = await runGeoGuard();
      await runAllFormTests({ geo: geoForm });
    } catch (err) {
      console.error('Form test failed:', err);
    }
  }

  // Daily report disabled for now — re-enable when needed.
}

export async function startScheduler(): Promise<void> {
  const settings = await fetchRuntimeSettings();
  console.log(
    `Beacon scheduler (${isStagingMode() ? getStagingLabel() : 'production'}). ` +
      `Forms ${settings.formTestTimesEastern.join(', ')} ET (load checks + daily report off).`
  );

  await schedulerTick();
  setInterval(() => void schedulerTick(), 60_000);
}

const isDirect = process.argv[1]?.includes('scheduler');
if (isDirect) {
  startScheduler().catch((err) => {
    console.error('Scheduler crashed:', err);
    process.exit(1);
  });
}
