import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { engineRootPath, getEnv } from '../config.js';

export type LogoAsset = {
  path: string;
  label: string;
  id: string;
};

const assignedBySite = new Map<string, LogoAsset>();
const assignedThisRun = new Set<string>();
let poolPromise: Promise<LogoAsset[]> | null = null;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function loadLogoPool(): Promise<LogoAsset[]> {
  const directory = join(engineRootPath(), 'assets', 'test-logos');
  const supported = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  const names = await readdir(directory).catch(() => [] as string[]);
  const assets: LogoAsset[] = [];
  const seenHashes = new Set<string>();

  for (const name of names.sort()) {
    if (!supported.has(extname(name).toLowerCase())) continue;
    const path = join(directory, name);
    const bytes = await readFile(path);
    const id = createHash('sha256').update(bytes).digest('hex');
    if (seenHashes.has(id)) continue;
    seenHashes.add(id);
    assets.push({ path, label: basename(name), id });
  }

  if (!assets.length) {
    const path = join(engineRootPath(), 'assets', 'test-logo.png');
    assets.push({ path, label: 'test-logo.png', id: 'legacy-test-logo' });
  }
  return assets;
}

async function logoPool(): Promise<LogoAsset[]> {
  poolPromise ||= loadLogoPool();
  return poolPromise;
}

/**
 * The first candidate is sticky to a brand during one workflow. Distinct
 * brands receive distinct primary logos while capacity permits. The second
 * candidate is a different image for one upload retry.
 */
export async function selectLogoCandidates(siteId: string): Promise<LogoAsset[]> {
  const logos = await logoPool();
  const existing = assignedBySite.get(siteId);
  let primary = existing;

  if (!primary) {
    const runSeed = getEnv('GITHUB_RUN_ID') || new Date().toISOString().slice(0, 10);
    const start = stableHash(`${runSeed}:${siteId}`) % logos.length;
    for (let offset = 0; offset < logos.length; offset += 1) {
      const candidate = logos[(start + offset) % logos.length]!;
      if (!assignedThisRun.has(candidate.id)) {
        primary = candidate;
        break;
      }
    }
    primary ||= logos[start]!;
    assignedBySite.set(siteId, primary);
    assignedThisRun.add(primary.id);
  }

  const alternate = logos.find((logo) => logo.id !== primary.id);
  return alternate ? [primary, alternate] : [primary];
}
