/**
 * Module 1 — Load and render checks.
 * Opens each site in a real browser, measures speed, looks for key elements,
 * and records console / network errors.
 */

import { devices, chromium, webkit, type Browser, type Page } from 'playwright';
import { loadConfig } from '../config.js';
import {
  closeIncident,
  countRecentSlowChecks,
  insertLoadCheck,
  openIncident,
} from '../db/supabase.js';
import type { DeviceProfile, GeoGuardResult, LoadCheckResult, SiteRow } from '../types.js';
import { getBrowserLaunchOptions } from '../utils/browser.js';
import { withMonitorParam } from '../utils/monitor-param.js';
import { captureCheckScreenshot } from '../utils/screenshots.js';
import { gotoWithRetries, sleep } from '../utils/navigate.js';
import { maybeSendAlert } from '../alerts/email.js';

const DEFAULT_SELECTORS: Record<string, string> = {
  logo: 'img[alt*="logo" i], a[href="/"] img, header img, .logo img, [class*="logo"] img',
  headline: 'h1',
  // Broad fallback — real CTA check also uses role/text patterns below
  cta: 'a[href*="quote" i], a[href*="mockup" i], button:has-text("Quote"), a:has-text("Quote")',
  quote_form: 'form, [class*="quote" i] form, form[action*="quote" i]',
};

/** Same site, ignore trailing slash / query / www so we can compare main vs form URL */
function samePageUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (u: URL) =>
      `${u.hostname.replace(/^www\./i, '')}${u.pathname.replace(/\/$/, '') || '/'}`.toLowerCase();
    return norm(ua) === norm(ub);
  } catch {
    return a.replace(/\/$/, '') === b.replace(/\/$/, '');
  }
}

/**
 * Quote form is often on a different page than the homepage.
 * Load checks only require the form when it lives on the same URL we just opened.
 */
function formExpectedOnMainPage(site: SiteRow): boolean {
  if (!site.quote_form_url) return true;
  return samePageUrl(site.main_url, site.quote_form_url);
}

const CTA_TEXT_PATTERNS = [
  /get my free quote/i,
  /get your free quote/i,
  /get a quote/i,
  /get free quote/i,
  /free quote/i,
  /request a quote/i,
  /get my free mockup/i,
  /get free.*mockup/i,
  /free.*mockup/i,
  /start design/i,
  /talk to a sign/i,
];

async function elementPresent(page: Page, selector: string): Promise<boolean> {
  try {
    const loc = page.locator(selector);
    const count = await loc.count();
    if (count === 0) return false;
    for (let i = 0; i < Math.min(count, 8); i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
    // Present in the page even if not currently "visible" (menu, below fold, etc.)
    return true;
  } catch {
    return false;
  }
}

async function checkCta(page: Page, siteSelectors: Record<string, string>): Promise<boolean> {
  if (siteSelectors.cta && (await elementPresent(page, siteSelectors.cta))) {
    return true;
  }

  for (const pattern of CTA_TEXT_PATTERNS) {
    const byRole = page
      .getByRole('link', { name: pattern })
      .or(page.getByRole('button', { name: pattern }));
    if ((await byRole.count()) > 0) return true;

    const byText = page.getByText(pattern);
    if ((await byText.count()) > 0) return true;
  }

  if (await elementPresent(page, DEFAULT_SELECTORS.cta)) return true;
  return false;
}

async function checkElements(
  page: Page,
  site: SiteRow
): Promise<Record<string, boolean>> {
  const siteSelectors = site.selectors || {};
  const result: Record<string, boolean> = {};

  result.logo = siteSelectors.logo
    ? await elementPresent(page, siteSelectors.logo)
    : await elementPresent(page, DEFAULT_SELECTORS.logo);
  result.headline = siteSelectors.headline
    ? await elementPresent(page, siteSelectors.headline)
    : await elementPresent(page, DEFAULT_SELECTORS.headline);

  const formOnThisPage = formExpectedOnMainPage(site);

  if (formOnThisPage) {
    // Main URL is the form page (or form URL not set separately).
    result.quote_form = siteSelectors.quote_form
      ? await elementPresent(page, siteSelectors.quote_form)
      : await elementPresent(page, DEFAULT_SELECTORS.quote_form);
    // Already on the form — do NOT require a separate "Get a Quote" button.
    result.cta = true;
  } else {
    // Homepage + separate quote form URL: only need the Get a Quote CTA here.
    // The form itself is checked by Module 2 on quote_form_url.
    result.quote_form = true;
    result.cta = await checkCta(page, siteSelectors);
  }

  return result;
}

async function launchForProfile(profile: DeviceProfile): Promise<{
  browser: Browser;
  contextOptions: Parameters<Browser['newContext']>[0];
}> {
  const config = loadConfig();
  const profileCfg = config.profiles[profile];

  if (profile === 'mobile' && profileCfg.device) {
    const device = devices[profileCfg.device];
    const browser = await chromium.launch(getBrowserLaunchOptions());
    return {
      browser,
      contextOptions: { ...device, locale: 'en-US', timezoneId: 'America/New_York' },
    };
  }

  if (profileCfg.browser === 'webkit') {
    const browser = await webkit.launch(getBrowserLaunchOptions());
    return {
      browser,
      contextOptions: {
        viewport: profileCfg.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
      },
    };
  }

  const browser = await chromium.launch(getBrowserLaunchOptions());
  return {
    browser,
    contextOptions: {
      viewport: profileCfg.viewport,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    },
  };
}

async function measureWebVitals(page: Page): Promise<{ lcpMs: number | null; cls: number | null }> {
  try {
    return await page.evaluate(() => {
      return new Promise<{ lcpMs: number | null; cls: number | null }>((resolve) => {
        let lcpMs: number | null = null;
        let cls = 0;
        try {
          const po = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.entryType === 'largest-contentful-paint') {
                lcpMs = entry.startTime;
              }
              if (entry.entryType === 'layout-shift' && !(entry as PerformanceEntry & { hadRecentInput?: boolean }).hadRecentInput) {
                cls += (entry as PerformanceEntry & { value?: number }).value || 0;
              }
            }
          });
          po.observe({ type: 'largest-contentful-paint', buffered: true });
          po.observe({ type: 'layout-shift', buffered: true });
        } catch {
          /* older browsers */
        }
        setTimeout(() => resolve({ lcpMs, cls }), 500);
      });
    });
  } catch {
    return { lcpMs: null, cls: null };
  }
}

export async function runLoadCheckForSiteProfile(
  site: SiteRow,
  profile: DeviceProfile,
  geo: GeoGuardResult
): Promise<LoadCheckResult> {
  const config = loadConfig();
  const url = withMonitorParam(site.main_url);
  const consoleErrors: Array<{ type: string; text: string }> = [];
  const failedRequests: Array<{ url: string; status: number | null; error?: string }> = [];

  let statusCode: number | null = null;
  let loaded = false;
  let loadMs: number | null = null;
  let lcpMs: number | null = null;
  let cls: number | null = null;
  let elementsOk: Record<string, boolean> = {};
  let screenshotPath: string | null = null;
  let notes: string | null = null;

  const { browser, contextOptions } = await launchForProfile(profile);
  try {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push({ type: msg.type(), text: msg.text().slice(0, 500) });
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push({ type: 'pageerror', text: err.message.slice(0, 500) });
    });
    page.on('requestfailed', (req) => {
      failedRequests.push({
        url: req.url().slice(0, 300),
        status: null,
        error: req.failure()?.errorText,
      });
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedRequests.push({ url: res.url().slice(0, 300), status: res.status() });
      }
    });

    const started = Date.now();
    try {
      const maxAttempts = loadConfig().gotoMaxAttempts ?? 4;
      const nav = await gotoWithRetries(page, url, maxAttempts);
      statusCode = nav.statusCode;
      loadMs = Date.now() - started;
      loaded = statusCode !== null && statusCode >= 200 && statusCode < 400;
      notes = nav.note;
      if (loaded) {
        await page.waitForTimeout(800);
        const vitals = await measureWebVitals(page);
        lcpMs = vitals.lcpMs !== null ? Math.round(vitals.lcpMs) : null;
        cls = vitals.cls;
        elementsOk = await checkElements(page, site);
      } else {
        elementsOk = {};
      }
    } catch (err) {
      loaded = false;
      loadMs = Date.now() - started;
      notes = err instanceof Error ? err.message : String(err);
    }

    // Critical only for what this page is supposed to have:
    // - separate form URL → homepage needs CTA
    // - form on this page → needs the form (CTA not required)
    const missingCritical = formExpectedOnMainPage(site)
      ? elementsOk.quote_form === false
      : elementsOk.cta === false;
    const failed =
      !loaded ||
      (statusCode !== null && statusCode >= 400) ||
      missingCritical;

    // Always capture for every profile (desktop / Safari / mobile) so Timeline can Preview
    try {
      screenshotPath = await captureCheckScreenshot(
        page,
        `${site.name}_${profile}`,
        failed ? 'failure' : 'success',
        failed ? 'failures' : 'load-checks'
      );
    } catch (err) {
      console.warn('Load-check screenshot failed:', err);
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const result: LoadCheckResult = {
    siteId: site.id,
    profile,
    statusCode,
    loaded,
    loadMs,
    lcpMs,
    cls,
    consoleErrors: consoleErrors.slice(0, 50),
    failedRequests: failedRequests.slice(0, 50),
    elementsOk,
    screenshotPath,
    notes,
    failed:
      !loaded ||
      (statusCode !== null && statusCode >= 400) ||
      (formExpectedOnMainPage(site)
        ? elementsOk.quote_form === false
        : elementsOk.cta === false),
  };

  await insertLoadCheck({
    site_id: site.id,
    profile,
    status_code: result.statusCode,
    loaded: result.loaded,
    load_ms: result.loadMs,
    lcp_ms: result.lcpMs,
    cls: result.cls,
    console_errors: result.consoleErrors,
    failed_requests: result.failedRequests,
    elements_ok: result.elementsOk,
    screenshot_path: result.screenshotPath,
    is_production: geo.isProduction,
    notes: result.notes,
    check_country: geo.country,
    check_ip: geo.ip,
  });

  // Rate limits are temporary CDN blocks — record the check, don't spam incidents/alerts
  if (result.statusCode === 429 || result.statusCode === 503) {
    await closeIncident(site.id, 'load_failure');
    // Keep a single open rate_limited note (openIncident dedupes by open type if supported;
    // if not, we still avoid email spam via cooldown when we skip maybeSendAlert here)
  } else if (!result.loaded || (result.statusCode !== null && result.statusCode >= 400)) {
    const id = await openIncident({
      site_id: site.id,
      type: 'load_failure',
      detail: `${site.name} [${profile}] failed to load. status=${result.statusCode}. ${result.notes || ''}`,
      screenshot_path: result.screenshotPath,
    });
    await maybeSendAlert({
      incidentId: id,
      siteId: site.id,
      siteName: site.name,
      type: 'load_failure',
      detail: `${site.name} [${profile}] failed to load (status ${result.statusCode}).`,
      screenshotPath: result.screenshotPath,
      cooldownHours: config.alertCooldownHours,
    });
    await closeIncident(site.id, 'rate_limited');
  } else {
    await closeIncident(site.id, 'load_failure');
    await closeIncident(site.id, 'rate_limited');
  }

  if (!formExpectedOnMainPage(site) && result.elementsOk.cta === false) {
    const id = await openIncident({
      site_id: site.id,
      type: 'missing_element',
      detail: `${site.name} [${profile}] Get a Quote button/link not found on homepage (form is on a separate URL). elements=${JSON.stringify(result.elementsOk)}`,
      screenshot_path: result.screenshotPath,
    });
    await maybeSendAlert({
      incidentId: id,
      siteId: site.id,
      siteName: site.name,
      type: 'missing_element',
      detail: `${site.name} [${profile}] is missing the Get a Quote CTA on the homepage.`,
      screenshotPath: result.screenshotPath,
      cooldownHours: config.alertCooldownHours,
    });
  } else if (
    formExpectedOnMainPage(site) &&
    result.elementsOk.quote_form === false
  ) {
    const id = await openIncident({
      site_id: site.id,
      type: 'missing_element',
      detail: `${site.name} [${profile}] quote form expected on this page but not found. elements=${JSON.stringify(result.elementsOk)}`,
      screenshot_path: result.screenshotPath,
    });
    await maybeSendAlert({
      incidentId: id,
      siteId: site.id,
      siteName: site.name,
      type: 'missing_element',
      detail: `${site.name} [${profile}] is missing the quote form on the monitored page.`,
      screenshotPath: result.screenshotPath,
      cooldownHours: config.alertCooldownHours,
    });
  } else {
    await closeIncident(site.id, 'missing_element');
  }

  if (
    result.loadMs !== null &&
    result.loadMs > config.loadTimeThresholdMs
  ) {
    const slowCount = await countRecentSlowChecks(
      site.id,
      profile,
      config.loadTimeThresholdMs,
      config.consecutiveSlowChecksBeforeAlert
    );
    if (slowCount >= config.consecutiveSlowChecksBeforeAlert) {
      const id = await openIncident({
        site_id: site.id,
        type: 'slow_load',
        detail: `${site.name} [${profile}] load ${result.loadMs}ms over threshold ${config.loadTimeThresholdMs}ms (${slowCount} consecutive).`,
        screenshot_path: result.screenshotPath,
      });
      await maybeSendAlert({
        incidentId: id,
        siteId: site.id,
        siteName: site.name,
        type: 'slow_load',
        detail: `${site.name} [${profile}] has been slow for ${slowCount} checks in a row (${result.loadMs}ms).`,
        screenshotPath: result.screenshotPath,
        cooldownHours: config.alertCooldownHours,
      });
    }
  } else {
    await closeIncident(site.id, 'slow_load');
  }

  return result;
}

export async function runAllLoadChecks(opts: {
  geo: GeoGuardResult;
  oneSite?: boolean;
  oneProfile?: boolean;
}): Promise<void> {
  const { fetchActiveSites } = await import('../db/supabase.js');
  const sites = await fetchActiveSites({ oneSite: opts.oneSite });
  if (sites.length === 0) {
    console.log('No active sites found in Supabase. Add sites in Settings or run the seed SQL.');
    return;
  }

  const profiles: DeviceProfile[] = opts.oneProfile
    ? ['desktop']
    : ['desktop', 'webkit', 'mobile'];

  console.log(
    `Load checks: ${sites.length} site(s) × ${profiles.length} profile(s). production=${opts.geo.isProduction}`
  );

  const cfg = loadConfig();
  const betweenChecks = cfg.delayMsBetweenChecks ?? 12000;
  const betweenProfiles = cfg.delayMsBetweenProfiles ?? 20000;
  const afterRateLimit = cfg.delayMsAfterRateLimit ?? 8000;
  const abortAfter = cfg.abortAfterConsecutiveRateLimits ?? 3;
  let consecutiveRateLimits = 0;

  // Profile outer loop: hit each site less often (desktop all sites → pause → Safari → …)
  for (let pi = 0; pi < profiles.length; pi++) {
    const profile = profiles[pi];
    for (const site of sites) {
      console.log(`→ ${site.name} / ${profile} …`);
      let statusCode: number | null = null;
      try {
        const result = await runLoadCheckForSiteProfile(site, profile, opts.geo);
        statusCode = result.statusCode;
        console.log(
          `  status=${result.statusCode} loaded=${result.loaded} loadMs=${result.loadMs} failed=${result.failed}`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  CHECK FAILED TO RUN: ${message}`);
        await openIncident({
          site_id: site.id,
          type: 'check_failed_to_run',
          detail: `Load check failed to run for ${site.name}/${profile}: ${message}`,
        });
        await insertLoadCheck({
          site_id: site.id,
          profile,
          status_code: null,
          loaded: false,
          load_ms: null,
          lcp_ms: null,
          cls: null,
          console_errors: [],
          failed_requests: [],
          elements_ok: {},
          screenshot_path: null,
          is_production: opts.geo.isProduction,
          notes: `check failed to run: ${message}`,
          check_country: opts.geo.country,
          check_ip: opts.geo.ip,
        });
      }

      if (statusCode === 429 || statusCode === 503) {
        consecutiveRateLimits += 1;
        console.log(
          `  rate-limit streak ${consecutiveRateLimits}/${abortAfter}`
        );
        if (consecutiveRateLimits >= abortAfter) {
          console.warn(
            `\n!!! ABORTING LOAD CHECKS — CDN rate-limited ${abortAfter} checks in a row. ` +
              `Stopping so this job does not run for 30+ minutes. Try again later or set PROXY_URL.\n`
          );
          return;
        }
      } else if (statusCode !== null && statusCode >= 200 && statusCode < 400) {
        consecutiveRateLimits = 0;
      }

      const pause =
        statusCode === 429 || statusCode === 503
          ? afterRateLimit
          : betweenChecks + Math.floor(Math.random() * 3000);
      console.log(`  pausing ${Math.round(pause / 1000)}s before next check…`);
      await sleep(pause);
    }
    if (pi < profiles.length - 1) {
      console.log(`  profile gap ${Math.round(betweenProfiles / 1000)}s before next browser…`);
      await sleep(betweenProfiles);
    }
  }
}
