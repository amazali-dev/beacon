/**
 * Module 2 — Quote form end-to-end test.
 * Layer 1: fill + submit, look for confirmation
 * Layer 2: IMAP inbox (logo attachment + Run ID)
 * Layer 3: CRM hook (placeholder, disconnected)
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
): Promise<void> {
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
  const notes: string[] = [];

  if (!site.form_testing_enabled) {
    console.log(`  Form testing disabled for ${site.name} — skipped.`);
    return;
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const submittedAt = Date.now();

  try {
    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await openQuoteFormIfNeeded(page);
    await page.locator('form, [class*="quote" i]').first().scrollIntoViewIfNeeded().catch(() => {});

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

    // Layer 3 — CRM placeholder (always disconnected for now)
    const crm = await verifyLeadInCrm(runId);
    layer3 = crm.pass;
    if (crm.note) notes.push(crm.note);
  } catch (err) {
    notes.push(
      `Form test failed to run: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Always keep a screenshot for the Forms tab / Timeline (success or failure)
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
    layer1 === false || (!submissionOnly && layer2 === false);
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
    `  Form test ${site.name}: runId=${runId} L1=${layer1} L2=${layer2} L3=${layer3} inboxSec=${submitToInboxSeconds}`
  );
  if (notes.length) {
    console.log(`  Notes: ${notes.join(' | ')}`);
  }
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
  for (const site of sites) {
    console.log(`→ Form test ${site.name}…`);
    await runFormTestForSite(site, opts.geo, { headed: opts.headed });
  }
}
