/**
 * Layer 3 CRM verification — hook only.
 * Leave disconnected until we confirm leads go to a CRM.
 */

export async function verifyLeadInCrm(runId: string): Promise<{
  pass: boolean | null;
  note: string;
}> {
  // Intentionally not connected.
  return {
    pass: null,
    note: `Layer 3 CRM check skipped (not connected yet). runId=${runId}`,
  };
}
