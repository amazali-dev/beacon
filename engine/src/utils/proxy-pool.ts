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
        const pool = result.pool.filter(validStoredProxy);
        if (pool.length > 0) return pool;
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

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/**
 * Pick one healthy fallback. The 30-minute bucket rotates assignments on each
 * scheduled run while site/profile keys spread traffic across the whole pool.
 */
export async function selectFallbackProxy(key: string): Promise<SelectedProxy | null> {
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
  const halfHourBucket = Math.floor(Date.now() / (30 * 60 * 1000));
  return available[hash(`${key}:${halfHourBucket}`) % available.length];
}

export function markProxyBlocked(proxy: SelectedProxy): void {
  blockedThisRun.add(proxy.id);
  console.warn(`${proxy.label} returned HTTP 429; cooling it down for the rest of this run.`);
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
