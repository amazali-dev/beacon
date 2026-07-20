/**
 * Saves failure screenshots locally, then uploads them to Supabase Storage.
 */

import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { engineRootPath } from '../config.js';
import { uploadScreenshot } from '../db/supabase.js';

export async function captureFormScreenshot(
  page: Page,
  label: string,
  kind: 'success' | 'failure' = 'failure'
): Promise<string | null> {
  try {
    const dir = join(engineRootPath(), 'screenshots-local');
    await mkdir(dir, { recursive: true });
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
    const filename = `${Date.now()}_${kind}_${safe}.png`;
    const localPath = join(dir, filename);
    await page.screenshot({ path: localPath, fullPage: true });

    const remotePath = `${kind === 'success' ? 'form-success' : 'failures'}/${filename}`;
    const publicUrl = await uploadScreenshot(localPath, remotePath);

    // Keep disk small — delete local copy after upload attempt
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

/** @deprecated Use captureFormScreenshot */
export async function captureFailureScreenshot(
  page: Page,
  label: string
): Promise<string | null> {
  return captureFormScreenshot(page, label, 'failure');
}
