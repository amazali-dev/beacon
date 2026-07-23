/**
 * Cut proxy bandwidth: abort image / font / media downloads.
 * Keeps document, scripts, XHR/fetch, stylesheets so checks still work.
 */
import type { BrowserContext, Page } from 'playwright';

const BLOCKED = new Set(['image', 'media', 'font']);

export async function blockHeavyAssets(target: BrowserContext | Page): Promise<void> {
  await target.route('**/*', async (route) => {
    if (BLOCKED.has(route.request().resourceType())) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}
