/**
 * Main entry for the monitoring engine.
 *
 * Examples:
 *   npm run check:one     — one site, desktop only (Step 2)
 *   npm run check:once    — all sites × all profiles once
 *   npm run form:one      — one site form test, headed browser
 *   npm run detect:forms  — auto-detect form field selectors
 *   npm run report:daily  — send daily report now
 *   npm run drain:jobs    — process dashboard "Run now" queue
 *   npm run scheduler     — keep running on the schedule
 */

import { getDeploymentMode, getStagingLabel, isStagingMode, loadConfig } from './config.js';
import { hasSupabaseConfigured } from './db/supabase.js';
import { touchEngineHeartbeat } from './db/settings.js';
import { runGeoGuard } from './geo-guard.js';
import { processPendingJobs } from './jobs/queue.js';
import { runAllLoadChecks } from './modules/load-check.js';
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
    await generateAndSendDailyReport();
    return;
  }

  if (hasFlag('--form-once')) {
    const geo = await runGeoGuard();
    await bumpHeartbeat(geo);
    if (shouldSkipProductionWrite(geo)) return;
    await runAllFormTests({
      geo,
      oneSite: hasFlag('--one-site'),
      headed: hasFlag('--headed'),
    });
    return;
  }

  // Default: load checks once (or --once)
  const geo = await runGeoGuard();
  await bumpHeartbeat(geo);
  if (shouldSkipProductionWrite(geo)) return;
  await runAllLoadChecks({
    geo,
    oneSite: hasFlag('--one-site'),
    oneProfile: hasFlag('--one-profile'),
  });
}

main().catch((err) => {
  console.error('Engine crashed:', err);
  process.exit(1);
});
