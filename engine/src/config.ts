/**
 * Loads settings from config/defaults.json and environment variables.
 * Site list does NOT live here — it comes from Supabase every run.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { EngineConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// config.ts lives in engine/src → one level up is the engine folder
const engineRoot = join(__dirname, '..');

// Load .env from the engine folder (secrets stay on the machine, never in code)
dotenv.config({ path: join(engineRoot, '.env') });

export function loadConfig(): EngineConfig {
  const raw = readFileSync(join(engineRoot, 'config/defaults.json'), 'utf8');
  return JSON.parse(raw) as EngineConfig;
}

export function getEnv(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(
      `Missing required setting: ${name}. ` +
        `On GitHub Actions, add it under Settings → Secrets and variables → Actions. ` +
        `For local testing only, copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export function engineRootPath(): string {
  return engineRoot;
}

/** staging = local/Pakistan tuning; production = GitHub Actions US runners */
export function getDeploymentMode(): 'staging' | 'production' {
  const fromEnv = getEnv('DEPLOYMENT_MODE').toLowerCase();
  if (fromEnv === 'staging' || fromEnv === 'production') {
    return fromEnv;
  }
  return loadConfig().deploymentMode || 'staging';
}

export function isStagingMode(): boolean {
  return getDeploymentMode() === 'staging';
}

export function getStagingLabel(): string {
  return loadConfig().stagingLabel || 'Staging';
}

/** Name / email / phone used when filling quote forms */
export function getTestIdentity(config: EngineConfig) {
  return {
    name: getEnv('TEST_NAME', config.testIdentity.name || 'amaz@beacon'),
    email: getEnv('TEST_EMAIL', config.testIdentity.email || 'amaz@beacon.com'),
    phone: getEnv('TEST_PHONE', config.testIdentity.phone || '5550100100'),
    messageTemplate: config.testIdentity.messageTemplate,
  };
}

export function isInboxVerificationEnabled(): boolean {
  if (getEnv('FORM_INBOX_VERIFICATION', '').toLowerCase() === 'true') return true;
  if (getEnv('FORM_INBOX_VERIFICATION', '').toLowerCase() === 'false') return false;
  return loadConfig().formInboxVerificationEnabled ?? false;
}
