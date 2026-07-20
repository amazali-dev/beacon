/**
 * Dashboard "Run now" queue — claimed by GitHub Actions (or a local scheduler).
 */

import {
  claimNextJob,
  finishJob,
  touchEngineHeartbeat,
  type CheckJobType,
} from '../db/settings.js';
import { getDeploymentMode, isStagingMode } from '../config.js';
import { runGeoGuard } from '../geo-guard.js';
import { detectFormsForAllSites } from '../modules/form-detect.js';
import { runAllFormTests } from '../modules/form-test.js';
import { runAllLoadChecks } from '../modules/load-check.js';
import { generateAndSendDailyReport } from '../reports/daily.js';

async function runJobType(jobType: CheckJobType): Promise<void> {
  const geo = await runGeoGuard();
  await touchEngineHeartbeat(isStagingMode() ? 'staging' : getDeploymentMode(), {
    country: geo.country,
    ip: geo.ip,
    isUs: geo.isUs,
  });

  if (getDeploymentMode() === 'production' && !geo.isUs) {
    throw new Error(
      `US IP guard blocked this queued job (country=${geo.country || 'unknown'}).`
    );
  }

  switch (jobType) {
    case 'load_check':
      await runAllLoadChecks({ geo });
      break;
    case 'form_test':
      await runAllFormTests({ geo });
      break;
    case 'detect_forms':
      await detectFormsForAllSites();
      break;
    case 'daily_report':
      await generateAndSendDailyReport();
      break;
  }
}

/** Claim and run pending dashboard jobs (up to `limit`). */
export async function processPendingJobs(limit = 5): Promise<number> {
  let ran = 0;
  for (let i = 0; i < limit; i++) {
    const job = await claimNextJob();
    if (!job) break;
    console.log(`\n=== Dashboard job: ${job.job_type} (${job.id}) ===`);
    try {
      await runJobType(job.job_type);
      await finishJob(job.id, true, 'Completed on GitHub Actions (US)');
      ran += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishJob(job.id, false, message);
      console.error(`Job failed: ${message}`);
      ran += 1;
    }
  }
  if (ran === 0) {
    console.log('No pending dashboard jobs.');
  }
  return ran;
}
