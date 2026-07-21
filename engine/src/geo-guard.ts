/**
 * US IP guard (production on GitHub Actions) or calm staging mode (local).
 *
 * Uses Cloudflare endpoints (not ipapi/ipwho free tiers) so we do not hit
 * "local_rate_limited" and lose location / skip production writes.
 */

import { getDeploymentMode, getEnv, getStagingLabel, isStagingMode, loadConfig } from './config.js';
import type { GeoGuardResult } from './types.js';

type GeoHit = { country: string | null; ip: string | null; source: string };

function onGithubActions(): boolean {
  return getEnv('GITHUB_ACTIONS', '').toLowerCase() === 'true';
}

function parseTrace(text: string): GeoHit | null {
  const map: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const ip = map.ip || null;
  const country = map.loc || null;
  if (!ip && !country) return null;
  return { country, ip, source: 'cloudflare-trace' };
}

/** Official-ish Cloudflare speed meta JSON — IP + country, no API key. */
async function lookupCloudflareMeta(): Promise<GeoHit | null> {
  const res = await fetch('https://speed.cloudflare.com/meta', {
    headers: { Accept: 'application/json', 'User-Agent': 'beacon-monitor/1.0' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    clientIp?: string;
    country?: string;
  };
  if (!data.clientIp && !data.country) return null;
  return {
    country: data.country || null,
    ip: data.clientIp || null,
    source: 'cloudflare-meta',
  };
}

/** Plain text key=value from Cloudflare edge. */
async function lookupCloudflareTrace(url: string): Promise<GeoHit | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'beacon-monitor/1.0' },
  });
  if (!res.ok) return null;
  return parseTrace(await res.text());
}

/** IP only — used if country providers fail but we still want the egress IP. */
async function lookupIpify(): Promise<GeoHit | null> {
  const res = await fetch('https://api.ipify.org?format=json', {
    headers: { Accept: 'application/json', 'User-Agent': 'beacon-monitor/1.0' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { ip?: string };
  if (!data.ip) return null;
  return { country: null, ip: data.ip, source: 'ipify' };
}

async function resolveGeo(): Promise<GeoHit> {
  const config = loadConfig();
  const configured = (config.geoCheckUrl || '').trim();
  // speed.cloudflare.com/meta often 403 from datacenter IPs — use cdn-cgi/trace first
  const attempts: Array<() => Promise<GeoHit | null>> = [
    () => lookupCloudflareTrace('https://cloudflare.com/cdn-cgi/trace'),
    () => lookupCloudflareTrace('https://1.1.1.1/cdn-cgi/trace'),
    lookupCloudflareMeta,
  ];
  if (configured.includes('cdn-cgi/trace') && !configured.includes('cloudflare.com/cdn-cgi/trace')) {
    attempts.push(() => lookupCloudflareTrace(configured));
  }
  attempts.push(lookupIpify);

  let bestCountry: string | null = null;
  let bestIp: string | null = null;
  let bestSource = '';

  for (const attempt of attempts) {
    const hit = await attempt().catch(() => null);
    if (!hit) continue;
    if (hit.country) bestCountry = hit.country;
    if (hit.ip) bestIp = hit.ip;
    bestSource = hit.source;
    if (bestCountry && bestIp) {
      console.log(`Geo OK via ${bestSource}: country=${bestCountry} ip=${bestIp}`);
      return { country: bestCountry, ip: bestIp, source: bestSource };
    }
  }

  if (bestIp || bestCountry) {
    console.log(
      `Geo partial via ${bestSource}: country=${bestCountry || '?'} ip=${bestIp || '?'}`
    );
    return { country: bestCountry, ip: bestIp, source: bestSource };
  }

  throw new Error('All geo lookup providers failed');
}

export async function runGeoGuard(): Promise<GeoGuardResult> {
  const config = loadConfig();
  const mode = getDeploymentMode();
  const stagingLabel = getStagingLabel();
  const forceProduction = getEnv('FORCE_PRODUCTION', 'false').toLowerCase() === 'true';
  const gha = onGithubActions();

  let country: string | null = null;
  let ip: string | null = null;

  try {
    const hit = await resolveGeo();
    country = hit.country;
    ip = hit.ip;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isStagingMode()) {
      console.log(
        `${stagingLabel}: geo lookup unavailable (${message}). Checks continue; data saved as staging.`
      );
    } else {
      console.warn(`\n!!! GEO CHECK FAILED: ${message}`);
      console.warn('!!! Treating this run as non-production.\n');
    }
    return {
      ok: true,
      isUs: false,
      country: null,
      ip: null,
      isProduction: false,
      deploymentMode: mode,
      stagingLabel,
      warning: isStagingMode()
        ? null
        : `Geo check failed (${message}). Results will NOT be marked as production.`,
    };
  }

  const isUs = (country || '').toUpperCase() === config.requiredCountry.toUpperCase();

  if (isStagingMode()) {
    console.log(
      `${stagingLabel} — running from ${country || 'unknown'} (${ip || 'unknown'}). ` +
        `Checks save normally; NON-US test data only. Production data comes from GitHub Actions (US).`
    );
    return {
      ok: true,
      isUs,
      country,
      ip,
      isProduction: false,
      deploymentMode: 'staging',
      stagingLabel,
      warning: null,
    };
  }

  if (!isUs) {
    const warning =
      `US IP GUARD BLOCKED THIS RUN — machine is in "${country || 'unknown'}", not ${config.requiredCountry}. ` +
      `IP: ${ip || 'unknown'}. Production data was NOT recorded. Next run will try again normally.`;
    console.warn('\n' + '!'.repeat(72));
    console.warn(warning);
    console.warn('!'.repeat(72) + '\n');
    return {
      ok: true,
      isUs: false,
      country,
      ip,
      isProduction: false,
      deploymentMode: 'production',
      stagingLabel,
      warning,
    };
  }

  const isProduction = forceProduction || (gha && isUs);
  if (isUs && !isProduction) {
    console.log(
      `US IP detected (${ip}), but FORCE_PRODUCTION is not true — saving as non-production.`
    );
  } else {
    console.log(`US production run OK. Country=${country} IP=${ip}`);
  }

  return {
    ok: true,
    isUs: true,
    country,
    ip,
    isProduction,
    deploymentMode: 'production',
    stagingLabel,
    warning: null,
  };
}
