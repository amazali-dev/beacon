import type { BrowserContext } from 'playwright';
import { getSupabase } from '../db/supabase.js';
import {
  getEnvironmentProxy,
  type BrowserProxy,
} from './browser.js';
import { blockHeavyAssets } from './bandwidth.js';

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
/** One primary proxy per brand for the whole workflow run. */
const proxyByBrandThisRun = new Map<string, string>();
/** Prefer unused proxies when assigning brands / alternate retries. */
const proxiesAssignedThisRun = new Set<string>();

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

function toSelected(entry: StoredProxy, index: number): SelectedProxy {
  return {
    id: entry.id || `proxy-${index + 1}`,
    label: entry.label || `Fallback ${index + 1}`,
    launch: {
      server: entry.server,
      ...(entry.username ? { username: entry.username } : {}),
      ...(entry.password ? { password: entry.password } : {}),
    },
  };
}

async function listAvailable(excludeIds: string[] = []): Promise<SelectedProxy[]> {
  const exclude = new Set(excludeIds);
  return (await pool())
    .map((entry, index) => toSelected(entry, index))
    .filter((entry) => !blockedThisRun.has(entry.id) && !exclude.has(entry.id));
}

function pickRandom(candidates: SelectedProxy[]): SelectedProxy {
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Assign one healthy proxy per brand for this workflow run. Brands receive
 * different proxies until every available proxy has been assigned; only then
 * is reuse allowed. The same brand keeps its proxy across profiles and forms.
 */
export async function selectFallbackProxy(brandId: string): Promise<SelectedProxy | null> {
  const available = await listAvailable();
  if (available.length === 0) return null;

  const existingId = proxyByBrandThisRun.get(brandId);
  const existing = existingId
    ? available.find((entry) => entry.id === existingId)
    : undefined;
  if (existing) return existing;

  const unused = available.filter((entry) => !proxiesAssignedThisRun.has(entry.id));
  const candidates = unused.length > 0 ? unused : available;
  const selected = pickRandom(candidates);
  proxyByBrandThisRun.set(brandId, selected.id);
  proxiesAssignedThisRun.add(selected.id);
  console.log(`  assigned ${selected.label} to brand ${brandId} for this run`);
  return selected;
}

/**
 * Pick a different healthy proxy for a one-shot retry (never GitHub direct).
 * Does not change the brand's sticky primary unless that primary is blocked.
 */
export async function selectAlternateProxy(
  brandId: string,
  excludeProxyId: string
): Promise<SelectedProxy | null> {
  const available = await listAvailable([excludeProxyId]);
  if (available.length === 0) return null;

  const unused = available.filter((entry) => !proxiesAssignedThisRun.has(entry.id));
  const candidates = unused.length > 0 ? unused : available;
  const selected = pickRandom(candidates);
  proxiesAssignedThisRun.add(selected.id);
  // If the brand's sticky proxy is blocked, promote this alternate for later profiles.
  const stickyId = proxyByBrandThisRun.get(brandId);
  if (!stickyId || blockedThisRun.has(stickyId)) {
    proxyByBrandThisRun.set(brandId, selected.id);
  }
  console.log(`  alternate ${selected.label} for brand ${brandId} (retry)`);
  return selected;
}

/** True when an enabled vault/env proxy pool has at least one entry this process can use. */
export async function hasProxyPoolCapacity(): Promise<boolean> {
  return (await pool()).length > 0;
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
  await blockHeavyAssets(context);
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
