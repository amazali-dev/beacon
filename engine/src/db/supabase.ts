/**
 * Talks to Supabase (our free database + screenshot storage).
 * Uses the service role key — only on the engine, never in the dashboard.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getDeploymentMode, getEnv, requireEnv } from '../config.js';
import type { SiteRow } from '../types.js';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Fresh site list at the start of every run (Settings page changes apply next run). */
export async function fetchActiveSites(opts?: {
  oneSite?: boolean;
  siteId?: string | null;
}): Promise<SiteRow[]> {
  const sb = getSupabase();
  let query = sb
    .from('sites')
    .select(
      'id,name,main_url,extra_urls,quote_form_url,form_testing_enabled,selectors,form_selectors,form_detection_status,active'
    )
    .eq('active', true)
    .order('name');

  if (opts?.oneSite) {
    query = query.limit(1);
  }
  if (opts?.siteId) {
    query = query.eq('id', opts.siteId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Could not load sites from database: ${error.message}`);
  }

  return (data || []).map((row) => ({
    ...row,
    extra_urls: Array.isArray(row.extra_urls) ? row.extra_urls : [],
    selectors: row.selectors || {},
    form_selectors: row.form_selectors || {},
    form_detection_status: row.form_detection_status || {},
  })) as SiteRow[];
}

export async function insertLoadCheck(row: {
  site_id: string;
  profile: string;
  status_code: number | null;
  loaded: boolean;
  load_ms: number | null;
  lcp_ms: number | null;
  cls: number | null;
  console_errors: unknown;
  failed_requests: unknown;
  elements_ok: unknown;
  screenshot_path: string | null;
  is_production: boolean;
  notes: string | null;
  check_country?: string | null;
  check_ip?: string | null;
  outcome?: 'success' | 'site_failure' | 'rate_limited' | 'monitor_error' | 'skipped';
  page_url?: string | null;
  workflow_run_id?: string | null;
  commit_sha?: string | null;
  direct_status?: number | null;
  fallback_status?: number | null;
  proxy_used?: boolean;
  egress_verified?: boolean;
}): Promise<void> {
  const { error } = await getSupabase().from('load_checks').insert(row);
  if (error) {
    throw new Error(`Could not save load check: ${error.message}`);
  }
}

export async function insertFormTest(row: {
  site_id: string;
  run_id: string;
  layer1_pass: boolean | null;
  layer2_pass: boolean | null;
  layer3_pass: boolean | null;
  submit_to_inbox_seconds: number | null;
  logo_upload_ok: boolean | null;
  screenshot_path: string | null;
  attempt_screenshot_paths?: string[];
  notes: string | null;
  is_production: boolean;
  check_country?: string | null;
  check_ip?: string | null;
  outcome?: 'success' | 'site_failure' | 'rate_limited' | 'monitor_error' | 'skipped';
  workflow_run_id?: string | null;
  commit_sha?: string | null;
  direct_status?: number | null;
  fallback_status?: number | null;
  proxy_used?: boolean;
  egress_verified?: boolean;
}): Promise<void> {
  const { error } = await getSupabase().from('form_tests').insert(row);
  if (error) {
    throw new Error(`Could not save form test: ${error.message}`);
  }
}

export async function updateSiteSelectors(
  siteId: string,
  patch: {
    selectors?: Record<string, string>;
    form_selectors?: Record<string, string>;
    form_detection_status?: Record<string, unknown>;
    quote_form_url?: string;
  }
): Promise<void> {
  const { error } = await getSupabase().from('sites').update(patch).eq('id', siteId);
  if (error) {
    throw new Error(`Could not update site selectors: ${error.message}`);
  }
}

export async function uploadScreenshot(
  localPath: string,
  remotePath: string
): Promise<string | null> {
  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile(localPath);
  const sb = getSupabase();
  const { error } = await sb.storage.from('screenshots').upload(remotePath, bytes, {
    contentType: 'image/png',
    upsert: true,
  });
  if (error) {
    console.warn(`Screenshot upload failed: ${error.message}`);
    return null;
  }
  return remotePath;
}

export async function findOpenIncident(
  siteId: string,
  type: string,
  isProduction = getDeploymentMode() === 'production'
): Promise<{ id: string; last_alerted_at: string | null } | null> {
  const { data, error } = await getSupabase()
    .from('incidents')
    .select('id,last_alerted_at')
    .eq('site_id', siteId)
    .eq('type', type)
    .eq('is_production', isProduction)
    .is('closed_at', null)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function openIncident(row: {
  site_id: string;
  type: string;
  detail: string;
  screenshot_path?: string | null;
  screenshot_paths?: string[];
  is_production?: boolean;
}): Promise<string> {
  const isProduction = row.is_production ?? getDeploymentMode() === 'production';
  const existing = await findOpenIncident(row.site_id, row.type, isProduction);
  if (existing) {
    const { error } = await getSupabase()
      .from('incidents')
      .update({
        detail: row.detail,
        screenshot_path: row.screenshot_path || null,
        screenshot_paths: row.screenshot_paths || [],
      })
      .eq('id', existing.id);
    if (error) throw new Error(error.message);
    return existing.id;
  }
  const { data, error } = await getSupabase()
    .from('incidents')
    .insert({
      site_id: row.site_id,
      type: row.type,
      detail: row.detail,
      screenshot_path: row.screenshot_path || null,
      screenshot_paths: row.screenshot_paths || [],
      alerted: false,
      is_production: isProduction,
    })
    .select('id')
    .single();
  if (error?.code === '23505') {
    const raced = await findOpenIncident(row.site_id, row.type, isProduction);
    if (raced) return raced.id;
  }
  if (error) throw new Error(error.message);
  return data.id;
}

export async function recordResolvedIncident(row: {
  site_id: string;
  type: string;
  detail: string;
  screenshot_path?: string | null;
  screenshot_paths?: string[];
  is_production?: boolean;
}): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('incidents')
    .insert({
      site_id: row.site_id,
      type: row.type,
      detail: row.detail,
      screenshot_path: row.screenshot_path || null,
      screenshot_paths: row.screenshot_paths || [],
      alerted: false,
      is_production: row.is_production ?? getDeploymentMode() === 'production',
      closed_at: now,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function closeIncident(
  siteId: string,
  type: string,
  isProduction = getDeploymentMode() === 'production'
): Promise<void> {
  const { error } = await getSupabase()
    .from('incidents')
    .update({ closed_at: new Date().toISOString() })
    .eq('site_id', siteId)
    .eq('type', type)
    .eq('is_production', isProduction)
    .is('closed_at', null);
  if (error) throw new Error(`Could not close incident: ${error.message}`);
}

export async function markIncidentAlerted(incidentId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('incidents')
    .update({
      alerted: true,
      last_alerted_at: new Date().toISOString(),
    })
    .eq('id', incidentId);
  if (error) throw new Error(`Could not mark incident alerted: ${error.message}`);
}

export async function countRecentSlowChecks(
  siteId: string,
  profile: string,
  thresholdMs: number,
  limit: number
): Promise<number> {
  const { data, error } = await getSupabase()
    .from('load_checks')
    .select('load_ms')
    .eq('site_id', siteId)
    .eq('profile', profile)
    .order('checked_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).filter((r) => r.load_ms != null && r.load_ms > thresholdMs).length;
}

export function hasSupabaseConfigured(): boolean {
  return Boolean(getEnv('SUPABASE_URL') && getEnv('SUPABASE_SERVICE_ROLE_KEY'));
}
