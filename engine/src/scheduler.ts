/**
 * Scheduler — reads schedule from Supabase (dashboard controls it).
 * Also processes "Run now" jobs from the dashboard.
 */

import { getDeploymentMode, getStagingLabel, isStagingMode } from './config.js';
import { fetchRuntimeSettings, touchEngineHeartbeat } from './db/settings.js';
import { runGeoGuard } from './geo-guard.js';
import { processPendingJobs } from './jobs/queue.js';
import { runAllLoadChecks, isEasternFormHour } from './modules/load-check.js';
import { runAllFormTests } from './modules/form-test.js';
import { generateAndSendDailyReport } from './reports/daily.js';

let lastLoadRun = 0;
const firedFormSlots = new Set<string>();
let firedReportDay = '';

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

  const now = Date.now();
  const loadDue =
    lastLoadRun === 0 ||
    now - lastLoadRun >= settings.loadCheckIntervalMinutes * 60 * 1000;

  if (loadDue) {
    if (isEasternFormHour(settings.formTestTimesEastern)) {
      console.log(
        '\n=== Skipping scheduled load-check (form tests run this Eastern hour) ==='
      );
    } else {
      console.log('\n=== Scheduled load-check run ===');
      try {
        await runAllLoadChecks({ geo });
        lastLoadRun = Date.now();
      } catch (err) {
        console.error('Load check failed:', err);
      }
    }
  }

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

  if (hm === settings.dailyReportTimeEastern && firedReportDay !== day) {
    firedReportDay = day;
    console.log('\n=== Daily report ===');
    try {
      await generateAndSendDailyReport();
    } catch (err) {
      console.error('Daily report failed:', err);
    }
  }
}

export async function startScheduler(): Promise<void> {
  const settings = await fetchRuntimeSettings();
  console.log(
    `Beacon scheduler (${isStagingMode() ? getStagingLabel() : 'production'}). ` +
      `Schedule from dashboard: load every ${settings.loadCheckIntervalMinutes} min, ` +
      `forms ${settings.formTestTimesEastern.join(', ')} ET, report ${settings.dailyReportTimeEastern} ET.`
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
