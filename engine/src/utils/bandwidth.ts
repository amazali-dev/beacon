/**
 * Cut proxy bandwidth: never download pictures, video/audio, or fonts.
 * Keeps document, scripts, XHR/fetch, stylesheets so checks still work.
 *
 * Blocks by Playwright resourceType AND by URL extension, so CDN/fetch
 * image/video requests that report as "other"/"fetch" still get aborted.
 */
import type { BrowserContext, Page } from 'playwright';

const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

/** Common image / video / audio / font path endings (querystring-safe). */
const BLOCKED_EXT =
  /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|apng|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi|m3u8|mpd|ts|m4s|mp3|m4a|aac|ogg|wav|flac|woff2?|ttf|otf|eot)(?:$|[?#])/i;

export async function blockHeavyAssets(target: BrowserContext | Page): Promise<void> {
  await target.route('**/*', async (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (BLOCKED_TYPES.has(type) || BLOCKED_EXT.test(req.url())) {
      await route.abort();
      return;
    }
    await route.continue();
  });
}
