/**
 * Shared Playwright launch options.
 * Reads optional PROXY_URL from the environment (GitHub Secret).
 * When empty, browsers go direct from the runner — that is the default.
 */

import type { LaunchOptions } from 'playwright';
import { getEnv } from '../config.js';

/** Launch options used by every check that opens a browser */
export function getBrowserLaunchOptions(
  overrides: LaunchOptions = {}
): LaunchOptions {
  const proxyUrl = getEnv('PROXY_URL');
  const proxy = proxyUrl ? { server: proxyUrl } : undefined;

  if (proxy) {
    console.log('PROXY_URL is set — routing browser traffic through the proxy.');
  }

  return {
    headless: true,
    ...overrides,
    ...(proxy ? { proxy } : {}),
  };
}
