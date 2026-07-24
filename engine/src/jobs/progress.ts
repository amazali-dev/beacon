/**
 * Live progress + cooperative cancel for dashboard Run now jobs.
 * Only active when a jobId is passed (queue path). Cron/CLI omit jobId.
 */

import { getSupabase } from '../db/supabase.js';

export type JobEventPhase = 'site_start' | 'step' | 'site_done' | 'job_done' | 'error';

export class JobCancelledError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job cancelled by user`);
    this.name = 'JobCancelledError';
    this.jobId = jobId;
  }
}

export function isJobCancelledError(err: unknown): boolean {
  return (
    err instanceof JobCancelledError ||
    (err instanceof Error && err.name === 'JobCancelledError')
  );
}

export async function emitJobEvent(
  jobId: string | undefined | null,
  input: {
    phase: JobEventPhase;
    message: string;
    siteId?: string | null;
    siteName?: string | null;
  }
): Promise<void> {
  if (!jobId) return;
  try {
    const sb = getSupabase();
    const { data: last } = await sb
      .from('check_job_events')
      .select('seq')
      .eq('job_id', jobId)
      .order('seq', { ascending: false })
      .limit(1)
      .maybeSingle();
    const seq = (last?.seq ?? 0) + 1;
    const { error } = await sb.from('check_job_events').insert({
      job_id: jobId,
      seq,
      site_id: input.siteId ?? null,
      site_name: input.siteName ?? null,
      phase: input.phase,
      message: input.message,
    });
    if (error) {
      console.warn(`job progress emit failed (${jobId}): ${error.message}`);
    }
  } catch (err) {
    console.warn(
      `job progress emit failed (${jobId}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function assertNotCancelled(jobId: string | undefined | null): Promise<void> {
  if (!jobId) return;
  try {
    const { data, error } = await getSupabase()
      .from('check_jobs')
      .select('cancel_requested_at')
      .eq('id', jobId)
      .maybeSingle();
    if (error) {
      console.warn(`cancel check failed (${jobId}): ${error.message}`);
      return;
    }
    if (data?.cancel_requested_at) {
      throw new JobCancelledError(jobId);
    }
  } catch (err) {
    if (isJobCancelledError(err)) throw err;
    console.warn(
      `cancel check failed (${jobId}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
