/**
 * Shared Playwright launch options.
 * Reads optional PROXY_URL from the environment (GitHub Secret).
 * When empty, browsers go direct from the runner — that is the default.
 *
 * Supported formats:
 *   http://user:pass@host:port
 *   http://host:port   (+ optional PROXY_USERNAME / PROXY_PASSWORD)
 *   socks5://host:port (auth often fails on Chromium — prefer http://)
 */

import type { BrowserContext, LaunchOptions, Page } from 'playwright';
import { getEnv } from '../config.js';

export type BrowserProxy = NonNullable<LaunchOptions['proxy']>;

/**
 * tsx/esbuild "keep names" rewrites nested helpers as `__name(fn, "name")`.
 * Playwright then serializes that source into the browser, where `__name` does
 * not exist → ReferenceError. Install a no-op shim on every document (string
 * form so tsx cannot transform it again).
 */
export const ESBUILD_NAME_SHIM =
  'globalThis.__name=function(fn){return fn};';

export async function applyEsbuildNameShim(
  target: BrowserContext | Page
): Promise<void> {
  await target.addInitScript(ESBUILD_NAME_SHIM);
}
export function parseProxy(
  raw: string,
  userFromEnv: string,
  passFromEnv: string
): BrowserProxy | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const u = new URL(withProto);
    if (!u.hostname) return undefined;

    const port = u.port ? `:${u.port}` : '';
    const server = `${u.protocol}//${u.hostname}${port}`;
    const username = decodeURIComponent(u.username || userFromEnv || '');
    const password = decodeURIComponent(u.password || passFromEnv || '');

    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    // Fallback: treat as bare host:port
    const server = trimmed.includes('://') ? trimmed : `http://${trimmed}`;
    return {
      server,
      ...(userFromEnv ? { username: userFromEnv } : {}),
      ...(passFromEnv ? { password: passFromEnv } : {}),
    };
  }
}

export function getEnvironmentProxy(): BrowserProxy | undefined {
  return parseProxy(
    getEnv('PROXY_URL'),
    getEnv('PROXY_USERNAME'),
    getEnv('PROXY_PASSWORD')
  );
}

/** Launch options used by every check that opens a browser */
export function getBrowserLaunchOptions(
  overrides: LaunchOptions = {},
  proxyOverride?: BrowserProxy | null
): LaunchOptions {
  // undefined preserves the legacy PROXY_URL behavior; null explicitly means direct.
  const proxy = proxyOverride === undefined ? getEnvironmentProxy() : proxyOverride || undefined;

  if (proxy) {
    console.log(
      `Browser proxy: ${proxy.server}` +
        (proxy.username ? ' (authenticated)' : '')
    );
  }

  return {
    headless: true,
    ...overrides,
    ...(proxy ? { proxy } : {}),
  };
}
