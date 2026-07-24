/**
 * Main entry for the monitoring engine.
 *
 * Examples:
 *   npm run check:one     — one site, desktop only (Step 2)
 *   npm run check:once    — all sites × current rotating profile once
 *   npm run check:once -- --all-profiles — all sites × desktop/Safari/mobile
 *   npm run form:one      — one site form test, headed browser
 *   npm run detect:forms  — auto-detect form field selectors
 *   npm run report:daily  — send daily report now
 *   npm run drain:jobs    — process dashboard "Run now" queue
 *   npm run scheduler     — keep running on the schedule
 */

import { getDeploymentMode, getStagingLabel, isStagingMode, loadConfig } from './config.js';
import { fetchActiveSites, hasSupabaseConfigured } from './db/supabase.js';
import {
  finishMonitorRun,
  hydrateRuntimeSettings,
  runRetention,
  startMonitorRun,
  touchEngineHeartbeat,
} from './db/settings.js';
import { runGeoGuard } from './geo-guard.js';
import { processPendingJobs } from './jobs/queue.js';
import {
  claimDueDailySlot,
  claimDueFormSlot,
  completeScheduleSlot,
} from './jobs/schedule-slots.js';
import { runOperationalWatchdog } from './jobs/watchdog.js';
import { runAllLoadChecks, isEasternFormHour } from './modules/load-check.js';
import { runAllFormTests } from './modules/form-test.js';
import { detectFormsForAllSites } from './modules/form-detect.js';
import { generateAndSendDailyReport } from './reports/daily.js';
import { startScheduler } from './scheduler.js';
import type { GeoGuardResult } from './types.js';

/** Mark the engine as alive so the dashboard watchdog stays green */
async function bumpHeartbeat(geo: GeoGuardResult): Promise<void> {
  try {
    await touchEngineHeartbeat(geo.isProduction ? 'production' : getDeploymentMode(), {
      country: geo.country,
      ip: geo.ip,
      isUs: geo.isUs,
    });
  } catch (err) {
    console.warn('Could not update engine heartbeat:', err);
  }
}

/**
 * In production mode, if the runner is not in the US, do not write check rows.
 * Staging (local) runs are allowed from any country and stay labeled non-production.
 */
function shouldSkipProductionWrite(geo: GeoGuardResult): boolean {
  if (getDeploymentMode() === 'production' && !geo.isUs) {
    console.warn('Skipping checks — US IP guard failed. No production rows written.');
    return true;
  }
  return false;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function trackedRun(
  jobType: string,
  geo: GeoGuardResult,
  expectedChecks: number,
  run: () => Promise<number>
): Promise<void> {
  const runKey = `${process.env.GITHUB_RUN_ID || `local-${Date.now()}`}:${jobType}`;
  await startMonitorRun({
    runKey,
    jobType,
    isProduction: geo.isProduction,
    country: geo.country,
    ip: geo.ip,
    expectedChecks,
  });
  try {
    const completed = await run();
    await finishMonitorRun(
      runKey,
      completed >= expectedChecks ? 'completed' : 'partial',
      completed,
      completed >= expectedChecks ? undefined : `Expected ${expectedChecks}; completed ${completed}`
    );
  } catch (err) {
    await finishMonitorRun(
      runKey,
      'failed',
      0,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

async function trackedDailyReport(reportDate?: string, suffix = 'manual'): Promise<void> {
  const runKey = `${process.env.GITHUB_RUN_ID || `local-${Date.now()}`}:daily_report:${suffix}`;
  await startMonitorRun({
    runKey,
    jobType: 'daily_report',
    isProduction: getDeploymentMode() === 'production',
    country: null,
    ip: null,
    expectedChecks: 1,
  });
  try {
    await generateAndSendDailyReport(reportDate);
    await finishMonitorRun(runKey, 'completed', 1);
  } catch (err) {
    await finishMonitorRun(
      runKey,
      'failed',
      0,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

async function main(): Promise<void> {
  console.log('Beacon monitoring engine');
  console.log('------------------------');

  if (!hasSupabaseConfigured()) {
    console.error(
      'Supabase is not configured.\n' +
        '1) Copy engine/.env.example to engine/.env\n' +
        '2) Paste SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY\n' +
        '3) Run the SQL files in supabase/ against your project'
    );
    process.exit(1);
  }

  await hydrateRuntimeSettings();
  const config = loadConfig();
  console.log(
    `Config loaded. Mode=${getDeploymentMode()}, interval=${config.loadCheckIntervalMinutes}m, slow threshold=${config.loadTimeThresholdMs}ms`
  );
  if (isStagingMode()) {
    console.log(`${getStagingLabel()} — alerts ${config.skipAlertsInStaging ? 'off' : 'on'} until US production.`);
  }

  if (hasFlag('--scheduler')) {
    await startScheduler();
    return;
  }

  if (hasFlag('--drain-jobs')) {
    const geo = await runGeoGuard();
    await bumpHeartbeat(geo);
    if (shouldSkipProductionWrite(geo)) return;
    const ran = await processPendingJobs(8);
    console.log(`Drain finished. Processed ${ran} job(s).`);
    return;
  }

  if (hasFlag('--detect-forms')) {
    const geo = await runGeoGuard();
    await bumpHeartbeat(geo);
    if (shouldSkipProductionWrite(geo)) return;
    await detectFormsForAllSites({ oneSite: hasFlag('--one-site') });
    return;
  }

  if (hasFlag('--daily-report')) {
    const geo = await runGeoGuard();
    await bumpHeartbeat(geo);
    // Daily report still runs — it only emails existing US production rows
    await trackedDailyReport();
    return;
  }

  if (hasFlag('--retention')) {
    await runRetention();
    console.log('Monitoring retention cleanup completed.');
    return;
  }

  if (hasFlag('--watchdog')) {
    await runOperationalWatchdog();
    console.log('Operational schedule watchdog completed.');
    return;
  }

  if (hasFlag('--daily-slot')) {
    const slot = await claimDueDailySlot();
    if (!slot) {
      console.log('No unclaimed daily-report slot is due.');
      return;
    }
    try {
      const geo = await runGeoGuard();
      await bumpHeartbeat(geo);
      await trackedDailyReport(slot.reportDate, slot.key);
      await completeScheduleSlot('daily_report', slot.key, true);
    } catch (err) {
      await completeScheduleSlot(
        'daily_report',
        slot.key,
        false,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
    return;
  }

  if (hasFlag('--form-slot')) {
    const slot = await claimDueFormSlot();
    if (!slot) {
      console.log('No unclaimed form-test slot is due.');
      return;
    }
    try {
      const geo = await runGeoGuard();
      await bumpHeartbeat(geo);
      if (shouldSkipProductionWrite(geo)) {
        await completeScheduleSlot('form_test', slot, false, 'US egress not verified');
        return;
      }
      const sites = (await fetchActiveSites()).filter((site) => site.form_testing_enabled);
      await trackedRun(`form_test:${slot}`, geo, sites.length, () =>
        runAllFormTests({ geo })
      );
      await completeScheduleSlot('form_test', slot, true);
    } catch (err) {
      await completeScheduleSlot(
        'form_test',
        slot,
        false,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
    return;
  }

  if (hasFlag('--form-once')) {
    const geo = await runGeoGuard();
    await bumpHeartbeat(geo);
    if (shouldSkipProductionWrite(geo)) return;
    const sites = (await fetchActiveSites({ oneSite: hasFlag('--one-site') })).filter(
      (site) => site.form_testing_enabled
    );
    await trackedRun('form_test', geo, sites.length, () =>
      runAllFormTests({
        geo,
        oneSite: hasFlag('--one-site'),
        headed: hasFlag('--headed'),
      })
    );
    return;
  }

  // Default: load checks once (or --once)
  // Scheduled loads skip Eastern hours that already run form tests (bandwidth).
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && isEasternFormHour(config.formTestTimesEastern)) {
    console.log(
      'Skipping scheduled load check — form tests run this Eastern hour (proxy bandwidth).'
    );
    const geo = await runGeoGuard();
    await bumpHeartbeat(geo);
    return;
  }

  const geo = await runGeoGuard();
  await bumpHeartbeat(geo);
  if (shouldSkipProductionWrite(geo)) return;
  const sites = await fetchActiveSites({ oneSite: hasFlag('--one-site') });
  const allProfiles = hasFlag('--all-profiles');
  const profileCount = allProfiles ? 3 : 1;
  await trackedRun('load_check', geo, sites.length * profileCount, () =>
    runAllLoadChecks({
      geo,
      oneSite: hasFlag('--one-site'),
      oneProfile: hasFlag('--one-profile'),
      allProfiles,
    })
  );
}

main().catch((err) => {
  console.error('Engine crashed:', err);
  process.exit(1);
});
