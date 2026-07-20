/**
 * US IP guard (production on GitHub Actions) or calm staging mode (local / Pakistan).
 */

import { getDeploymentMode, getEnv, getStagingLabel, isStagingMode, loadConfig } from './config.js';
import type { GeoGuardResult } from './types.js';

export async function runGeoGuard(): Promise<GeoGuardResult> {
  const config = loadConfig();
  const mode = getDeploymentMode();
  const stagingLabel = getStagingLabel();
  const forceProduction = getEnv('FORCE_PRODUCTION', 'false').toLowerCase() === 'true';

  let country: string | null = null;
  let ip: string | null = null;

  try {
    const res = await fetch(config.geoCheckUrl, {
      headers: {
        'User-Agent': 'beacon-monitor/1.0',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const fallback = await fetch('https://ipwho.is/');
      if (!fallback.ok) {
        throw new Error(`Geo lookup HTTP ${res.status}`);
      }
      const data = (await fallback.json()) as {
        country_code?: string;
        ip?: string;
      };
      country = data.country_code || null;
      ip = data.ip || null;
    } else {
      const data = (await res.json()) as {
        country_code?: string;
        country?: string;
        ip?: string;
      };
      country = data.country_code || data.country || null;
      ip = data.ip || null;
    }
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

  // Production mode (GitHub Actions): must be US + FORCE_PRODUCTION
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
