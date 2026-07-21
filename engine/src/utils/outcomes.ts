export type CheckOutcome =
  | 'success'
  | 'site_failure'
  | 'rate_limited'
  | 'monitor_error'
  | 'skipped';

export function classifyCheckOutcome(input: {
  statusCode: number | null;
  completedSuccessfully: boolean;
  rateLimitEvidence?: boolean;
  monitorError?: boolean;
  egressVerified: boolean;
}): CheckOutcome {
  if (input.monitorError || !input.egressVerified) return 'monitor_error';
  if (input.rateLimitEvidence || input.statusCode === 429) return 'rate_limited';
  if (
    input.completedSuccessfully &&
    input.statusCode !== null &&
    input.statusCode >= 200 &&
    input.statusCode < 400
  ) {
    return 'success';
  }
  return 'site_failure';
}
