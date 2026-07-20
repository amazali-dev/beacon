/**
 * Adds ?monitor=1 to every checked URL so analytics can ignore bot traffic.
 */

import { loadConfig } from '../config.js';

export function withMonitorParam(url: string): string {
  const config = loadConfig();
  const [param, value] = config.monitorQueryParam.split('=');
  const u = new URL(url);
  u.searchParams.set(param || 'monitor', value || '1');
  return u.toString();
}
