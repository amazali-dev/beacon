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
import {
  assertNotCancelled,
  emitJobEvent,
  isJobCancelledError,
} from './progress.js';

async function runJobType(
  jobType: CheckJobType,
  siteId: string | null,
  jobId: string
): Promise<void> {
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

  await assertNotCancelled(jobId);

  switch (jobType) {
    case 'load_check':
      await runAllLoadChecks({ geo, siteId, jobId });
      break;
    case 'form_test':
      await runAllFormTests({ geo, siteId, jobId });
      break;
    case 'detect_forms':
      await detectFormsForAllSites({ jobId });
      break;
    case 'daily_report':
      await generateAndSendDailyReport(undefined, { jobId });
      break;
  }
}

/** Claim and run pending dashboard jobs (up to `limit`). */
export async function processPendingJobs(limit = 5): Promise<number> {
  let ran = 0;
  for (let i = 0; i < limit; i++) {
    let job: {
      id: string;
      job_type: CheckJobType;
      site_id: string | null;
      cancel_requested_at: string | null;
    } | null;
    try {
      job = await claimNextJob();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Could not claim next dashboard job: ${message}`);
      throw new Error(`Queue claim failed: ${message}`);
    }
    if (!job) break;

    if (job.cancel_requested_at) {
      await finishJob(job.id, false, 'Cancelled before work started', { cancelled: true });
      await emitJobEvent(job.id, { phase: 'job_done', message: 'Cancelled' });
      ran += 1;
      continue;
    }

    console.log(`\n=== Dashboard job: ${job.job_type} (${job.id}) ===`);
    try {
      await runJobType(job.job_type, job.site_id, job.id);
      await emitJobEvent(job.id, { phase: 'job_done', message: 'Job finished' });
      await finishJob(job.id, true, 'Completed on GitHub Actions (US)');
      ran += 1;
    } catch (err) {
      if (isJobCancelledError(err)) {
        try {
          await emitJobEvent(job.id, { phase: 'job_done', message: 'Stopped by user' });
          await finishJob(job.id, false, 'Stopped by user', { cancelled: true });
        } catch (finishErr) {
          console.error(
            `Could not mark job ${job.id} cancelled: ${
              finishErr instanceof Error ? finishErr.message : String(finishErr)
            }`
          );
        }
        console.log(`Job cancelled: ${job.id}`);
        ran += 1;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      try {
        await emitJobEvent(job.id, { phase: 'error', message: message.slice(0, 500) });
        await finishJob(job.id, false, message.slice(0, 1800));
      } catch (finishErr) {
        console.error(
          `Could not mark job ${job.id} failed: ${
            finishErr instanceof Error ? finishErr.message : String(finishErr)
          }`
        );
      }
      console.error(`Job failed: ${message}`);
      ran += 1;
    }
  }
  if (ran === 0) {
    console.log('No pending dashboard jobs.');
  }
  return ran;
}
