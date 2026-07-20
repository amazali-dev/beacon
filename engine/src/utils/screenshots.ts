/**
 * Saves check screenshots locally, then uploads them to Supabase Storage.
 * Used for every load profile (desktop / Safari / mobile) and form tests.
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { engineRootPath } from '../config.js';
import { uploadScreenshot } from '../db/supabase.js';

export type ScreenshotKind = 'success' | 'failure';

export async function captureCheckScreenshot(
  page: Page,
  label: string,
  kind: ScreenshotKind = 'success',
  folder: 'load-checks' | 'form-success' | 'failures' = 'load-checks'
): Promise<string | null> {
  try {
    const dir = join(engineRootPath(), 'screenshots-local');
    await mkdir(dir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
    const filename = `${Date.now()}_${kind}_${safe}.png`;
    const localPath = join(dir, filename);
    await page.screenshot({ path: localPath, fullPage: true });

    const remotePath = `${folder}/${filename}`;
    const publicUrl = await uploadScreenshot(localPath, remotePath);

    try {
      await unlink(localPath);
    } catch {
      /* ignore */
    }

    return publicUrl || remotePath;
  } catch (err) {
    console.warn('Screenshot capture failed:', err);
    return null;
  }
}

export async function captureFormScreenshot(
  page: Page,
  label: string,
  kind: ScreenshotKind = 'failure'
): Promise<string | null> {
  return captureCheckScreenshot(
    page,
    label,
    kind,
    kind === 'success' ? 'form-success' : 'failures'
  );
}

/** @deprecated Use captureCheckScreenshot */
export async function captureFailureScreenshot(
  page: Page,
  label: string
): Promise<string | null> {
  return captureCheckScreenshot(page, label, 'failure', 'failures');
}
