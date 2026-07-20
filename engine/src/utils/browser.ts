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

import type { LaunchOptions } from 'playwright';
import { getEnv } from '../config.js';

function parseProxy(
  raw: string,
  userFromEnv: string,
  passFromEnv: string
): NonNullable<LaunchOptions['proxy']> | undefined {
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

/** Launch options used by every check that opens a browser */
export function getBrowserLaunchOptions(
  overrides: LaunchOptions = {}
): LaunchOptions {
  const proxy = parseProxy(
    getEnv('PROXY_URL'),
    getEnv('PROXY_USERNAME'),
    getEnv('PROXY_PASSWORD')
  );

  if (proxy) {
    console.log(
      `PROXY_URL is set — browser traffic via ${proxy.server}` +
        (proxy.username ? ' (authenticated)' : '')
    );
  }

  return {
    headless: true,
    ...overrides,
    ...(proxy ? { proxy } : {}),
  };
}
