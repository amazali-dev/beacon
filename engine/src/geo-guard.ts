/**
 * US IP guard (production on GitHub Actions) or calm staging mode (local).
 * Uses multiple free geo providers so one rate-limit does not break runs.
 */

import { getDeploymentMode, getEnv, getStagingLabel, isStagingMode, loadConfig } from './config.js';
import type { GeoGuardResult } from './types.js';

type GeoHit = { country: string | null; ip: string | null };

async function lookupIpwho(): Promise<GeoHit | null> {
  const res = await fetch('https://ipwho.is/', {
    headers: { Accept: 'application/json', 'User-Agent': 'beacon-monitor/1.0' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (/rate.?limit/i.test(text) || text.trim() === 'local_rate_limited') return null;
  const data = JSON.parse(text) as {
    success?: boolean;
    country_code?: string;
    ip?: string;
  };
  if (data.success === false) return null;
  return { country: data.country_code || null, ip: data.ip || null };
}

async function lookupIpapi(url: string): Promise<GeoHit | null> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'beacon-monitor/1.0' },
  });
  const text = await res.text();
  // Free tier often returns plain text when over quota
  if (!res.ok || /rate.?limit/i.test(text) || text.trim() === 'local_rate_limited') {
    return null;
  }
  const data = JSON.parse(text) as {
    error?: boolean;
    reason?: string;
    country_code?: string;
    country?: string;
    ip?: string;
  };
  if (data.error || /rate/i.test(data.reason || '')) return null;
  return {
    country: data.country_code || data.country || null,
    ip: data.ip || null,
  };
}

async function resolveGeo(primaryUrl: string): Promise<GeoHit> {
  // Prefer ipwho.is first — ipapi.co free tier rate-limits quickly and returns "local_rate_limited"
  const fromWho = await lookupIpwho().catch(() => null);
  if (fromWho?.country) return fromWho;

  const fromApi = await lookupIpapi(primaryUrl).catch(() => null);
  if (fromApi?.country) return fromApi;

  const fromApiFallback = await lookupIpapi('https://ipapi.co/json/').catch(() => null);
  if (fromApiFallback?.country) return fromApiFallback;

  throw new Error('All geo lookup providers failed or rate-limited');
}

export async function runGeoGuard(): Promise<GeoGuardResult> {
  const config = loadConfig();
  const mode = getDeploymentMode();
  const stagingLabel = getStagingLabel();
  const forceProduction = getEnv('FORCE_PRODUCTION', 'false').toLowerCase() === 'true';

  let country: string | null = null;
  let ip: string | null = null;

  try {
    const hit = await resolveGeo(config.geoCheckUrl);
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

  const isProduction = forceProduction;
  if (isUs && !forceProduction) {
    console.log(
      `US IP detected (${ip}), but FORCE_PRODUCTION is not true — saving as non-production.`
    );
  } else {
    console.log(`US production run OK (GitHub Actions). Country=${country} IP=${ip}`);
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
