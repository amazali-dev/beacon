/**
 * Module 1 — Load and render checks.
 * Opens each site in a real browser, measures speed, looks for key elements,
 * and records console / network errors.
 */

import { devices, chromium, webkit, type Browser, type Page } from 'playwright';
import { getEnv, loadConfig } from '../config.js';
import {
  closeIncident,
  countRecentSlowChecks,
  insertLoadCheck,
  openIncident,
} from '../db/supabase.js';
import type { DeviceProfile, GeoGuardResult, LoadCheckResult, SiteRow } from '../types.js';
import { getBrowserLaunchOptions } from '../utils/browser.js';
import { withMonitorParam } from '../utils/monitor-param.js';
import {
  markProxyBlocked,
  selectFallbackProxy,
  verifyProxyEgress,
  type SelectedProxy,
} from '../utils/proxy-pool.js';
import { classifyCheckOutcome } from '../utils/outcomes.js';
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

async function launchForProfile(profile: DeviceProfile, proxy?: SelectedProxy): Promise<{
  browser: Browser;
  contextOptions: Parameters<Browser['newContext']>[0];
}> {
  const config = loadConfig();
  const profileCfg = config.profiles[profile];

  if (profile === 'mobile' && profileCfg.device) {
    const device = devices[profileCfg.device];
    const browser = await chromium.launch(getBrowserLaunchOptions({}, proxy?.launch ?? null));
    return {
      browser,
      contextOptions: { ...device, locale: 'en-US', timezoneId: 'America/New_York' },
    };
  }

  if (profileCfg.browser === 'webkit') {
    const browser = await webkit.launch(getBrowserLaunchOptions({}, proxy?.launch ?? null));
    return {
      browser,
      contextOptions: {
        viewport: profileCfg.viewport,
        locale: 'en-US',
        timezoneId: 'America/New_York',
      },
    };
  }

  const browser = await chromium.launch(getBrowserLaunchOptions({}, proxy?.launch ?? null));
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

type LoadAttempt = {
  statusCode: number | null;
  loaded: boolean;
  loadMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  elementsOk: Record<string, boolean>;
  screenshotPath: string | null;
  notes: string | null;
  consoleErrors: Array<{ type: string; text: string }>;
  failedRequests: Array<{ url: string; status: number | null; error?: string }>;
  country: string | null;
  ip: string | null;
};

async function runLoadAttempt(
  site: SiteRow,
  profile: DeviceProfile,
  url: string,
  proxy?: SelectedProxy
): Promise<LoadAttempt> {
  const consoleErrors: LoadAttempt['consoleErrors'] = [];
  const failedRequests: LoadAttempt['failedRequests'] = [];
  let statusCode: number | null = null;
  let loaded = false;
  let loadMs: number | null = null;
  let lcpMs: number | null = null;
  let cls: number | null = null;
  let elementsOk: Record<string, boolean> = {};
  let screenshotPath: string | null = null;
  let notes: string | null = null;
  let country: string | null = null;
  let ip: string | null = null;

  const { browser, contextOptions } = await launchForProfile(profile, proxy);
  try {
    const context = await browser.newContext(contextOptions);
    if (proxy) {
      const egress = await verifyProxyEgress(context);
      country = egress.country;
      ip = egress.ip;
      console.log(
        `  fallback ${proxy.label}: ${egress.country || 'unknown country'} / ${egress.ip || 'unknown IP'}`
      );
    }

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
      // The outer direct/fallback flow owns the strict two-attempt limit.
      const nav = await gotoWithRetries(page, url, 1);
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
      }
    } catch (err) {
      loadMs = Date.now() - started;
      notes = err instanceof Error ? err.message : String(err);
    }

    const missingCritical = formExpectedOnMainPage(site)
      ? elementsOk.quote_form === false
      : elementsOk.cta === false;
    const failed =
      !loaded || (statusCode !== null && statusCode >= 400) || missingCritical;

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

  return {
    statusCode,
    loaded,
    loadMs,
    lcpMs,
    cls,
    elementsOk,
    screenshotPath,
    notes,
    consoleErrors: consoleErrors.slice(0, 50),
    failedRequests: failedRequests.slice(0, 50),
    country,
    ip,
  };
}

export async function runLoadCheckForSiteProfile(
  site: SiteRow,
  profile: DeviceProfile,
  geo: GeoGuardResult
): Promise<LoadCheckResult> {
  const config = loadConfig();
  const url = withMonitorParam(site.main_url);
  let attempt = await runLoadAttempt(site, profile, url);
  const directStatus = attempt.statusCode;
  let fallbackStatus: number | null = null;
  let proxyUsed = false;
  let checkCountry = geo.country;
  let checkIp = geo.ip;
  const productionEgressRequired = geo.deploymentMode === 'production';
  let egressVerified =
    !productionEgressRequired || (geo.isUs && Boolean(geo.country && geo.ip));

  if (attempt.statusCode === 429) {
    const proxy = await selectFallbackProxy(site.id);
    if (proxy) {
      console.log(`  direct attempt returned HTTP 429; retrying once via ${proxy.label}`);
      const directNote = attempt.notes || 'Direct attempt returned HTTP 429.';
      try {
        proxyUsed = true;
        const fallback = await runLoadAttempt(site, profile, url, proxy);
        fallbackStatus = fallback.statusCode;
        if (fallback.statusCode === 429) await markProxyBlocked(proxy);
        fallback.notes =
          `Attempt 1 direct: HTTP 429. Attempt 2 ${proxy.label}: ` +
          `${fallback.statusCode ?? 'no response'}. ${fallback.notes || ''}`;
        attempt = fallback;
        // Once proxy traffic is used, never mislabel it with the runner's direct IP.
        checkCountry = fallback.country;
        checkIp = fallback.ip;
        egressVerified = productionEgressRequired
          ? (fallback.country || '').toUpperCase() === config.requiredCountry.toUpperCase() &&
            Boolean(fallback.ip)
          : Boolean(fallback.ip);
        if (!egressVerified) {
          fallback.notes =
            `${fallback.notes || ''} ` +
            'Proxy egress was not verified in the required country; excluded from site health.';
          await markProxyBlocked(proxy, 'Unknown or non-US proxy egress');
        }
      } catch (err) {
        await markProxyBlocked(
          proxy,
          `Fallback execution failed: ${err instanceof Error ? err.message : String(err)}`
        );
        attempt.notes =
          `${directNote} Fallback ${proxy.label} could not run: ` +
          `${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      attempt.notes =
        `${attempt.notes || 'Direct attempt returned HTTP 429.'} ` +
        'No enabled fallback proxy was available.';
    }
  }

  const {
    statusCode,
    loaded,
    loadMs,
    lcpMs,
    cls,
    elementsOk,
    screenshotPath,
    notes,
    consoleErrors,
    failedRequests,
  } = attempt;
  const outcome = classifyCheckOutcome({
    statusCode,
    completedSuccessfully: loaded,
    egressVerified,
  });

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
    check_country: checkCountry,
    check_ip: checkIp,
    outcome,
    page_url: site.main_url,
    workflow_run_id: getEnv('GITHUB_RUN_ID') || null,
    commit_sha: getEnv('GITHUB_SHA') || null,
    direct_status: directStatus,
    fallback_status: fallbackStatus,
    proxy_used: proxyUsed,
    egress_verified: egressVerified,
  });

  // A definite 429 is a monitor/CDN block — record it, but do not call the site down.
  // A 503 follows the hard-failure path below because it can be real unavailability.
  if (!egressVerified) {
    await openIncident({
      site_id: site.id,
      type: 'check_failed_to_run',
      detail: `${site.name} [${profile}] monitor egress could not be verified. ${result.notes || ''}`,
      screenshot_path: result.screenshotPath,
    });
  } else if (result.statusCode === 429) {
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
    await closeIncident(site.id, 'check_failed_to_run');
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
  siteId?: string | null;
}): Promise<number> {
  const { fetchActiveSites } = await import('../db/supabase.js');
  const sites = await fetchActiveSites({ oneSite: opts.oneSite, siteId: opts.siteId });
  if (sites.length === 0) {
    console.log('No active sites found in Supabase. Add sites in Settings or run the seed SQL.');
    return 0;
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
  let completedChecks = 0;

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
        completedChecks += 1;
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
          outcome: 'monitor_error',
          page_url: site.main_url,
          workflow_run_id: getEnv('GITHUB_RUN_ID') || null,
          commit_sha: getEnv('GITHUB_SHA') || null,
          egress_verified:
            opts.geo.deploymentMode !== 'production' ||
            (opts.geo.isUs && Boolean(opts.geo.ip)),
        });
        completedChecks += 1;
      }

      if (statusCode === 429) {
        consecutiveRateLimits += 1;
        console.log(
          `  rate-limit streak ${consecutiveRateLimits}/${abortAfter}`
        );
        if (consecutiveRateLimits >= abortAfter) {
          console.warn(
            `\n!!! ABORTING LOAD CHECKS — ${abortAfter} consecutive HTTP 429 responses. ` +
              `Stopping to avoid escalating CDN blocking.\n`
          );
          return completedChecks;
        }
      } else if (statusCode !== null && statusCode >= 200 && statusCode < 400) {
        consecutiveRateLimits = 0;
      }

      const pause =
        statusCode === 429
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
  return completedChecks;
}
