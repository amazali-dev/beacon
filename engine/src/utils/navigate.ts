/** Navigate with short retries on HTTP 429 blocks and transient HTTP 503 responses. */

import type { Page, Response } from 'playwright';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export type GotoResult = {
  statusCode: number | null;
  attempts: number;
  note: string | null;
  rateLimited: boolean;
};

function retryAfterMs(response: Response | null, attempt: number): number {
  const header = response?.headers()?.['retry-after'];
  const parsed = header ? Number(header) * 1000 : NaN;
  if (Number.isFinite(parsed)) {
    return Math.min(45_000, Math.max(8_000, parsed));
  }
  // Keep short — long waits turn one blocked run into a 30+ minute job
  return Math.min(20_000, 8_000 * attempt);
}

export async function gotoWithRetries(
  page: Page,
  url: string,
  maxAttempts = 3
): Promise<GotoResult> {
  let statusCode: number | null = null;
  let note: string | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResponse = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    statusCode = lastResponse?.status() ?? null;

    if (statusCode !== null && statusCode >= 200 && statusCode < 400) {
      await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
      if (attempt > 1) {
        note = `Loaded after ${attempt} attempts (earlier responses were rate-limited)`;
      }
      return { statusCode, attempts: attempt, note, rateLimited: false };
    }

    if (statusCode === 429 || statusCode === 503) {
      const backoff = retryAfterMs(lastResponse, attempt);
      console.log(
        `  HTTP ${statusCode} — waiting ${Math.round(backoff / 1000)}s then retry ${attempt}/${maxAttempts}`
      );
      note =
        statusCode === 429
          ? `Site returned HTTP 429 (too many requests). Retried ${attempt} time(s).`
          : `Site returned HTTP 503 (service unavailable). Retried ${attempt} time(s).`;
      if (attempt < maxAttempts) {
        await sleep(backoff);
        continue;
      }
      return {
        statusCode,
        attempts: attempt,
        note,
        // Only 429 conclusively means rate limiting. 503 can be a real outage.
        rateLimited: statusCode === 429,
      };
    }

    if (statusCode !== null && statusCode >= 500 && attempt < maxAttempts) {
      await sleep(8000);
      continue;
    }
    return { statusCode, attempts: attempt, note, rateLimited: false };
  }

  return {
    statusCode,
    attempts: maxAttempts,
    note,
    rateLimited: statusCode === 429,
  };
}

/** True when the page looks like a CDN/WAF block instead of the real site. */
export async function pageLooksRateLimited(page: Page): Promise<boolean> {
  const text = await page.locator('body').innerText().catch(() => '');
  return /too many requests|rate.?limit|access denied|attention required|cf-error|just a moment/i.test(
    text
  );
}

export { sleep };
