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
import { captureFailureScreenshot } from '../utils/screenshots.js';
import { maybeSendAlert } from '../alerts/email.js';

const DEFAULT_SELECTORS: Record<string, string> = {
  logo: 'img[alt*="logo" i], a[href="/"] img, header img, .logo img, [class*="logo"] img',
  headline: 'h1',
  cta: 'a[href*="quote" i], button:has-text("Quote"), a:has-text("Get a Quote"), a:has-text("Free Quote")',
  quote_form: 'form, [class*="quote" i] form, form[action*="quote" i]',
};

async function launchForProfile(profile: DeviceProfile): Promise<{
  browser: Browser;
  contextOptions: Parameters<Browser['newContext']>[0];
}> {
  const config = loadConfig();
  const profileCfg = config.profiles[profile];

  if (profile === 'mobile' && profileCfg.device) {
    const device = devices[profileCfg.device];
    const browser = await chromium.launch(getBrowserLaunchOptions());
    return { browser, contextOptions: { ...device } };
  }

  if (profileCfg.browser === 'webkit') {
    const browser = await webkit.launch(getBrowserLaunchOptions());
    return {
      browser,
      contextOptions: { viewport: profileCfg.viewport },
    };
  }

  const browser = await chromium.launch(getBrowserLaunchOptions());
  return {
    browser,
    contextOptions: { viewport: profileCfg.viewport },
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

async function checkElements(
  page: Page,
  selectors: Record<string, string>
): Promise<Record<string, boolean>> {
  const merged = { ...DEFAULT_SELECTORS, ...selectors };
  const result: Record<string, boolean> = {};
  for (const [name, selector] of Object.entries(merged)) {
    try {
      const loc = page.locator(selector).first();
      result[name] = (await loc.count()) > 0 && (await loc.isVisible().catch(() => false));
    } catch {
      result[name] = false;
    }
  }
  return result;
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
      const response = await page.goto(url, {
        waitUntil: 'load',
        timeout: 45000,
      });
      statusCode = response?.status() ?? null;
      loadMs = Date.now() - started;
      loaded = statusCode !== null && statusCode >= 200 && statusCode < 400;
      await page.waitForTimeout(800);
      const vitals = await measureWebVitals(page);
      lcpMs = vitals.lcpMs !== null ? Math.round(vitals.lcpMs) : null;
      cls = vitals.cls;
      elementsOk = await checkElements(page, site.selectors || {});
    } catch (err) {
      loaded = false;
      loadMs = Date.now() - started;
      notes = err instanceof Error ? err.message : String(err);
    }

    const missingCritical =
      elementsOk.cta === false || elementsOk.quote_form === false;
    const failed =
      !loaded ||
      (statusCode !== null && statusCode >= 400) ||
      missingCritical;

    if (failed) {
      screenshotPath = await captureFailureScreenshot(
        page,
        `${site.name}_${profile}`
      );
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
      elementsOk.cta === false ||
      elementsOk.quote_form === false,
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
  });

  // Incidents + alerts
  if (!result.loaded || (result.statusCode !== null && result.statusCode >= 400)) {
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
  } else {
    await closeIncident(site.id, 'load_failure');
  }

  if (result.elementsOk.cta === false || result.elementsOk.quote_form === false) {
    const id = await openIncident({
      site_id: site.id,
      type: 'missing_element',
      detail: `${site.name} [${profile}] missing CTA or quote form. elements=${JSON.stringify(result.elementsOk)}`,
      screenshot_path: result.screenshotPath,
    });
    await maybeSendAlert({
      incidentId: id,
      siteId: site.id,
      siteName: site.name,
      type: 'missing_element',
      detail: `${site.name} [${profile}] is missing a key element (CTA or quote form).`,
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

  for (const site of sites) {
    for (const profile of profiles) {
      console.log(`→ ${site.name} / ${profile} …`);
      try {
        const result = await runLoadCheckForSiteProfile(site, profile, opts.geo);
        console.log(
          `  status=${result.statusCode} loaded=${result.loaded} loadMs=${result.loadMs} failed=${result.failed}`
        );
      } catch (err) {
        // Never invent a pass — record failure note via incident
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
        });
      }
    }
  }
}
