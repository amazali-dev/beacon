import type { BrowserContext } from 'playwright';
import { getSupabase } from '../db/supabase.js';
import {
  getEnvironmentProxy,
  type BrowserProxy,
} from './browser.js';

type StoredProxy = BrowserProxy & {
  id?: string;
  label?: string;
};

export type SelectedProxy = {
  id: string;
  label: string;
  launch: BrowserProxy;
};

export type ProxyEgress = {
  ip: string | null;
  country: string | null;
};

let poolPromise: Promise<StoredProxy[]> | null = null;
const blockedThisRun = new Set<string>();
/** Prefer unused proxies within a run before reusing any. */
const proxiesUsedThisRun = new Set<string>();

function validStoredProxy(value: unknown): value is StoredProxy {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.server === 'string' &&
    /^https?:\/\/[^@\s]+$/i.test(entry.server) &&
    (entry.username === undefined || typeof entry.username === 'string') &&
    (entry.password === undefined || typeof entry.password === 'string')
  );
}

async function fetchPool(): Promise<StoredProxy[]> {
  try {
    const { data, error } = await getSupabase().rpc('get_proxy_pool');
    if (error) {
      console.warn(`Proxy pool unavailable: ${error.message}`);
    } else {
      const result = data as { enabled?: boolean; pool?: unknown } | null;
      if (result?.enabled && Array.isArray(result.pool)) {
        const stored = result.pool.filter(validStoredProxy);
        if (stored.length > 0) {
          const { data: health, error: healthError } = await getSupabase()
            .from('proxy_health')
            .select('proxy_id,blocked_until');
          if (healthError) {
            console.warn(`Proxy health unavailable: ${healthError.message}`);
            return stored;
          }
          const now = Date.now();
          const blocked = new Set(
            (health || [])
              .filter((row) => row.blocked_until && new Date(row.blocked_until).getTime() > now)
              .map((row) => row.proxy_id)
          );
          return stored.filter((entry, index) => !blocked.has(entry.id || `proxy-${index + 1}`));
        }
      }
    }
  } catch (err) {
    console.warn(
      `Proxy pool unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Backward-compatible fallback for the existing GitHub PROXY_* secrets.
  const environmentProxy = getEnvironmentProxy();
  return environmentProxy
    ? [{ id: 'environment-proxy', label: 'GitHub secret proxy', ...environmentProxy }]
    : [];
}

async function pool(): Promise<StoredProxy[]> {
  poolPromise ||= fetchPool();
  return poolPromise;
}

/**
 * Pick a healthy fallback proxy for this check.
 * Random each call — not sticky for a whole run. Prefers proxies not yet
 * used in this run until the pool is exhausted, then reshuffles.
 */
export async function selectFallbackProxy(brandId: string): Promise<SelectedProxy | null> {
  const available = (await pool())
    .map((entry, index) => ({
      id: entry.id || `proxy-${index + 1}`,
      label: entry.label || `Fallback ${index + 1}`,
      launch: {
        server: entry.server,
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.password ? { password: entry.password } : {}),
      },
    }))
    .filter((entry) => !blockedThisRun.has(entry.id));

  if (available.length === 0) return null;

  const unused = available.filter((entry) => !proxiesUsedThisRun.has(entry.id));
  const candidates = unused.length > 0 ? unused : available;
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  proxiesUsedThisRun.add(selected.id);
  console.log(`  assigned ${selected.label} at random for brand ${brandId}`);
  return selected;
}

/**
 * Skip a proxy for the rest of this workflow run.
 * Only persist a multi-hour cooldown for broken proxy infrastructure
 * (bad egress / tunnel failures). Target-site HTTP 429 must NOT burn the
 * whole pool for 2 hours — that created a death spiral where every later
 * check had "No enabled fallback proxy was available".
 */
export async function markProxyBlocked(
  proxy: SelectedProxy,
  reason = 'HTTP 429 from target',
  opts?: { persistCooldownMinutes?: number }
): Promise<void> {
  blockedThisRun.add(proxy.id);
  const persistMinutes = opts?.persistCooldownMinutes;
  if (persistMinutes == null) {
    console.warn(`${proxy.label}: ${reason} — skipping for the rest of this run only.`);
    return;
  }

  console.warn(
    `${proxy.label}: ${reason} — cooling down for ${persistMinutes} minutes.`
  );
  const { error } = await getSupabase().rpc('record_proxy_failure', {
    p_proxy_id: proxy.id,
    p_reason: reason,
    p_cooldown_minutes: persistMinutes,
  });
  if (error) console.warn(`Could not persist proxy cooldown: ${error.message}`);
}

export async function verifyProxyEgress(context: BrowserContext): Promise<ProxyEgress> {
  const page = await context.newPage();
  try {
    const response = await page.goto('https://www.cloudflare.com/cdn-cgi/trace', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    if (!response?.ok()) return { ip: null, country: null };
    const body = await page.locator('body').innerText();
    const values = new Map(
      body
        .split(/\r?\n/)
        .map((line) => line.split('=', 2))
        .filter((parts): parts is [string, string] => parts.length === 2)
    );
    return {
      ip: values.get('ip') || null,
      country: values.get('loc')?.toUpperCase() || null,
    };
  } catch {
    return { ip: null, country: null };
  } finally {
    await page.close().catch(() => {});
  }
}
