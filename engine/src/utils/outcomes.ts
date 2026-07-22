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
  // CDN blocks are not monitor failures. Keep them ahead of egress warnings so
  // a 429 + unverified fallback proxy is still reported as rate-limited.
  if (input.rateLimitEvidence || input.statusCode === 429) return 'rate_limited';
  if (input.monitorError || !input.egressVerified) return 'monitor_error';
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

export function classifyFormOutcome(input: {
  statusCode: number | null;
  submissionConfirmed: boolean;
  rateLimitEvidence?: boolean;
  monitorError?: boolean;
  egressVerified: boolean;
}): CheckOutcome {
  // A captured thank-you/confirmation screen is definitive evidence that the
  // form task succeeded. Keep unverified egress as metadata/warning, but do
  // not overwrite the confirmed site result.
  if (input.submissionConfirmed) return 'success';
  return classifyCheckOutcome({
    statusCode: input.statusCode,
    completedSuccessfully: false,
    rateLimitEvidence: input.rateLimitEvidence,
    monitorError: input.monitorError,
    egressVerified: input.egressVerified,
  });
}
