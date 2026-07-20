/**
 * Module 2 — Quote form end-to-end test.
 * Layer 1: fill + submit, look for confirmation
 * Layer 2: IMAP inbox (logo attachment + Run ID)
 * Layer 3: CRM hook (placeholder, disconnected)
 *
 * CDN HTTP 429 is treated as a skip (not a form failure) so rate limits
 * do not open false "form broken" incidents.
 */

import { join } from 'node:path';
import { chromium } from 'playwright';
import { engineRootPath, getTestIdentity, isInboxVerificationEnabled, loadConfig } from '../config.js';
import {
  fetchActiveSites,
  insertFormTest,
  openIncident,
  closeIncident,
} from '../db/supabase.js';
import { maybeSendAlert } from '../alerts/email.js';
import { verifyInboxForRunId } from './imap-verify.js';
import { verifyLeadInCrm } from '../hooks/crm-layer3.js';
import { getBrowserLaunchOptions } from '../utils/browser.js';
import { withMonitorParam } from '../utils/monitor-param.js';
import { captureFormScreenshot } from '../utils/screenshots.js';
import { gotoWithRetries, pageLooksRateLimited, sleep } from '../utils/navigate.js';
import {
  clickQuoteSubmit,
  completeSignageQuoteSteps,
  fillContactFields,
  openQuoteFormIfNeeded,
  waitForThankYou,
} from './form-fill-helpers.js';
import { detectFormFieldsForSite } from './form-detect.js';
import type { GeoGuardResult, SiteRow } from '../types.js';

function buildRunId(): string {
  return `MON-${Date.now()}`;
}

async function ensureFormSelectors(site: SiteRow): Promise<SiteRow> {
  const keys = Object.keys(site.form_selectors || {});
  if (keys.length >= 3) return site;
  console.log(`  No form selectors yet for ${site.name} — running auto-detection…`);
  const report = await detectFormFieldsForSite(site);
  for (const line of report.plainEnglish) {
    console.log(`    ${line}`);
  }
  const refreshed = await fetchActiveSites();
  return refreshed.find((s) => s.id === site.id) || site;
}

export async function runFormTestForSite(
  site: SiteRow,
  geo: GeoGuardResult,
  opts?: { headed?: boolean }
): Promise<{ rateLimited: boolean; ok: boolean }> {
  const config = loadConfig();
  const identity = getTestIdentity(config);
  const runId = buildRunId();
  const message = identity.messageTemplate.replace('{runId}', runId);
  const logoPath = join(engineRootPath(), 'assets/test-logo.png');

  let layer1: boolean | null = null;
  let layer2: boolean | null = null;
  let layer3: boolean | null = null;
  let submitToInboxSeconds: number | null = null;
  let logoUploadOk: boolean | null = null;
  let screenshotPath: string | null = null;
  let rateLimited = false;
  const notes: string[] = [];

  if (!site.form_testing_enabled) {
    console.log(`  Form testing disabled for ${site.name} — skipped.`);
    return { rateLimited: false, ok: true };
  }

  const siteReady = await ensureFormSelectors(site);
  const selectors = siteReady.form_selectors || {};
  const formUrl = withMonitorParam(siteReady.quote_form_url || siteReady.main_url);

  const browser = await chromium.launch(
    getBrowserLaunchOptions({
      headless: opts?.headed ? false : true,
      slowMo: opts?.headed ? 250 : 0,
    })
  );
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const submittedAt = Date.now();

  try {
    const maxAttempts = config.gotoMaxAttempts ?? 3;
    const nav = await gotoWithRetries(page, formUrl, maxAttempts);
    if (nav.note) notes.push(nav.note);

    if (nav.rateLimited || (await pageLooksRateLimited(page))) {
      rateLimited = true;
      notes.push(
        'SKIPPED: site/CDN rate-limited the form test (HTTP 429). Not counted as a form failure — will retry next slot.'
      );
      screenshotPath = await captureFormScreenshot(page, `form_ratelimit_${site.name}_${runId}`, 'failure');
    } else {
      await page.waitForTimeout(2500);
      await openQuoteFormIfNeeded(page);
      await page
        .locator('form, [class*="quote" i]')
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});

      // If fields still missing, wait once more — often a soft block / slow hydrate after 429
      const nameVisible = await page
        .locator(
          'input[name*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]'
        )
        .first()
        .isVisible({ timeout: 4000 })
        .catch(() => false);
      if (!nameVisible) {
        await sleep(15000);
        if (await pageLooksRateLimited(page)) {
          rateLimited = true;
          notes.push(
            'SKIPPED: page still looks rate-limited after wait. Not counted as a form failure.'
          );
        }
      }

      if (!rateLimited) {
        await fillContactFields(page, identity, selectors, notes);

        if (selectors.file) {
          try {
            await page.locator(selectors.file).first().setInputFiles(logoPath);
            logoUploadOk = true;
          } catch {
            logoUploadOk = false;
            notes.push('Logo upload failed');
          }
        } else {
          const fileInput = page.locator('input[type="file"]').first();
          if (await fileInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            try {
              await fileInput.setInputFiles(logoPath);
              logoUploadOk = true;
            } catch {
              logoUploadOk = false;
              notes.push('Logo upload failed');
            }
          } else {
            logoUploadOk = false;
            notes.push('No file upload field detected');
          }
        }

        notes.push(...(await completeSignageQuoteSteps(page, message)));
        await page.waitForTimeout(800);

        await clickQuoteSubmit(page, selectors.submit);

        const layer1Timeout = config.formLayer1TimeoutSeconds * 1000;
        layer1 = await waitForThankYou(page, layer1Timeout);
        if (!layer1) {
          notes.push('Layer 1: no thank-you screen within timeout');
        }

        screenshotPath = await captureFormScreenshot(
          page,
          `form_${site.name}_${runId}`,
          layer1 ? 'success' : 'failure'
        );
        if (layer1) notes.push('Thank-you screen captured');

        if (isInboxVerificationEnabled()) {
          try {
            const inbox = await verifyInboxForRunId(runId, {
              timeoutMinutes: config.formLayer2TimeoutMinutes,
              requireAttachment: true,
              submittedAt,
            });
            layer2 = inbox.found;
            submitToInboxSeconds = inbox.delaySeconds;
            if (!inbox.found) notes.push(inbox.note || 'Layer 2: Run ID email not found');
            if (inbox.found && !inbox.hasAttachment) {
              notes.push('Layer 2: email found but logo attachment missing');
              layer2 = false;
            }
          } catch (err) {
            layer2 = null;
            notes.push(
              `Layer 2 check failed to run: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } else {
          layer2 = null;
        }

        const crm = await verifyLeadInCrm(runId);
        layer3 = crm.pass;
        if (crm.note) notes.push(crm.note);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/429|rate.?limit|too many requests/i.test(msg) || (await pageLooksRateLimited(page))) {
      rateLimited = true;
      notes.push(`SKIPPED due to rate limit: ${msg}`);
    } else {
      notes.push(`Form test failed to run: ${msg}`);
      // Field/submit missing often means we landed on a block page after soft 429
      if (
        /submit button not found|field fill failed/i.test(notes.join(' ')) &&
        (await pageLooksRateLimited(page))
      ) {
        rateLimited = true;
        notes.push('SKIPPED: treated as CDN rate limit (block page), not a form bug.');
        layer1 = null;
      }
    }
  }

  if (!screenshotPath) {
    try {
      screenshotPath = await captureFormScreenshot(
        page,
        `form_${site.name}_${runId}`,
        layer1 ? 'success' : 'failure'
      );
    } catch {
      /* ignore */
    }
  }

  await browser.close();

  // Rate-limited runs: leave layer1 null so dashboard does not treat as failed submit
  if (rateLimited) {
    layer1 = null;
    layer2 = null;
    logoUploadOk = null;
  }

  await insertFormTest({
    site_id: site.id,
    run_id: runId,
    layer1_pass: layer1,
    layer2_pass: layer2,
    layer3_pass: layer3,
    submit_to_inbox_seconds: submitToInboxSeconds,
    logo_upload_ok: logoUploadOk,
    screenshot_path: screenshotPath,
    notes: notes.join(' | ') || null,
    is_production: geo.isProduction,
    check_country: geo.country,
    check_ip: geo.ip,
  });

  const submissionOnly = !isInboxVerificationEnabled();
  const anyFail =
    !rateLimited && (layer1 === false || (!submissionOnly && layer2 === false));
  if (anyFail) {
    const id = await openIncident({
      site_id: site.id,
      type: 'form_test_failure',
      detail: `${site.name} form test failed. L1=${layer1} L2=${layer2}. ${notes.join(' ')}`,
      screenshot_path: screenshotPath,
    });
    await maybeSendAlert({
      incidentId: id,
      siteId: site.id,
      siteName: site.name,
      type: 'form_test_failure',
      detail: `${site.name} quote form test failed (Layer1=${layer1}, Layer2=${layer2}).`,
      screenshotPath,
      cooldownHours: config.alertCooldownHours,
    });
  } else if (layer1 === true && (submissionOnly || layer2 === true)) {
    await closeIncident(site.id, 'form_test_failure');
  }

  console.log(
    `  Form test ${site.name}: runId=${runId} L1=${layer1} L2=${layer2} rateLimited=${rateLimited}`
  );
  if (notes.length) {
    console.log(`  Notes: ${notes.join(' | ')}`);
  }

  return {
    rateLimited,
    ok: layer1 === true,
  };
}

export async function runAllFormTests(opts: {
  geo: GeoGuardResult;
  oneSite?: boolean;
  headed?: boolean;
}): Promise<void> {
  const sites = (await fetchActiveSites({ oneSite: opts.oneSite })).filter(
    (s) => s.form_testing_enabled
  );
  if (sites.length === 0) {
    console.log('No sites with form testing enabled.');
    return;
  }

  const pauseMs = loadConfig().delayMsBetweenChecks ?? 12000;
  const abortAfter = loadConfig().abortAfterConsecutiveRateLimits ?? 3;
  let consecutiveRateLimits = 0;

  console.log(`Form tests: waiting 20s before first site…`);
  await sleep(20_000);

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    console.log(`→ Form test ${site.name}…`);
    const result = await runFormTestForSite(site, opts.geo, { headed: opts.headed });
    if (result.rateLimited) {
      consecutiveRateLimits += 1;
      console.log(`  form rate-limit streak ${consecutiveRateLimits}/${abortAfter}`);
      if (consecutiveRateLimits >= abortAfter) {
        console.warn(
          `\n!!! ABORTING FORM TESTS — CDN rate-limited ${abortAfter} sites in a row. Stopping early.\n`
        );
        return;
      }
    } else if (result.ok) {
      consecutiveRateLimits = 0;
    }
    if (i < sites.length - 1) {
      const gap = pauseMs + 10_000;
      console.log(`  pausing ${Math.round(gap / 1000)}s before next form site…`);
      await sleep(gap);
    }
  }
}
