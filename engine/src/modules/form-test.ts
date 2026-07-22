/**
 * Module 2 — Quote form end-to-end test.
 * Layer 1: fill + submit, look for confirmation
 * Layer 2: IMAP inbox (logo attachment + Run ID)
 * Layer 3: CRM hook (placeholder, disconnected)
 *
 * CDN HTTP 429 is treated as a skip (not a form failure) so rate limits
 * do not open false "form broken" incidents.
 */

import { chromium, type Locator, type Page } from 'playwright';
import {
  getAbortAfterConsecutiveRateLimits,
  getEnv,
  getTestIdentity,
  isInboxVerificationEnabled,
  loadConfig,
} from '../config.js';
import {
  fetchActiveSites,
  insertFormTest,
  openIncident,
  closeIncident,
  recordResolvedIncident,
} from '../db/supabase.js';
import { maybeSendAlert } from '../alerts/email.js';
import { verifyInboxForRunId } from './imap-verify.js';
import { verifyLeadInCrm } from '../hooks/crm-layer3.js';
import { getBrowserLaunchOptions } from '../utils/browser.js';
import { withMonitorParam } from '../utils/monitor-param.js';
import {
  markProxyBlocked,
  selectAlternateProxy,
  selectFallbackProxy,
  type SelectedProxy,
  verifyProxyEgress,
} from '../utils/proxy-pool.js';
import { classifyFormOutcome } from '../utils/outcomes.js';
import {
  selectLogoCandidates,
  type LogoAsset,
} from '../utils/logo-pool.js';
import { captureFormScreenshot } from '../utils/screenshots.js';
import { gotoWithRetries, pageLooksRateLimited, sleep } from '../utils/navigate.js';
import {
  clickQuoteSubmit,
  completeSignageQuoteSteps,
  fillContactFields,
  fillWebsiteOrBusinessFallback,
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

async function waitForLogoUploadState(
  page: Page,
  timeoutMs = 30_000
): Promise<'success' | 'failed' | 'quiet'> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const failed = await page
      .getByText(/failed\s*(?:to upload|[-—:]\s*network error)|upload failed|network error/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (failed) return 'failed';

    const succeeded = await page
      .getByText(/upload(?:ed)? successfully|upload complete|logo uploaded/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (succeeded) return 'success';

    const uploading = await page
      .getByText(/uploading/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (!uploading && Date.now() - started >= 4_000) return 'quiet';
    await page.waitForTimeout(500);
  }
  return 'failed';
}

async function uploadLogoOnce(
  page: Page,
  fileInput: Locator,
  logo: LogoAsset,
  attempt: number,
  notes: string[]
): Promise<boolean> {
  await fileInput.setInputFiles(logo.path);
  notes.push(`Attempt ${attempt}: uploading logo ${logo.label}`);
  const state = await waitForLogoUploadState(page);
  if (state === 'success' || state === 'quiet') {
    notes.push(`Attempt ${attempt}: logo upload accepted`);
    return true;
  }
  notes.push(`Attempt ${attempt}: logo upload reported a network failure`);
  return false;
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
  let layer1: boolean | null = null;
  let layer2: boolean | null = null;
  let layer3: boolean | null = null;
  let submitToInboxSeconds: number | null = null;
  let logoUploadOk: boolean | null = null;
  let logoRecoveredAfterRefresh = false;
  let screenshotPath: string | null = null;
  const attemptScreenshotPaths: string[] = [];
  let rateLimited = false;
  let monitorError = false;
  let directStatus: number | null = null;
  let fallbackStatus: number | null = null;
  let proxyUsed = false;
  let selectedProxy: SelectedProxy | null = null;
  const productionEgressRequired = geo.deploymentMode === 'production';
  let egressVerified =
    !productionEgressRequired || (geo.isUs && Boolean(geo.country && geo.ip));
  let checkCountry = geo.country;
  let checkIp = geo.ip;
  const notes: string[] = [];

  if (!site.form_testing_enabled) {
    console.log(`  Form testing disabled for ${site.name} — skipped.`);
    return { rateLimited: false, ok: true };
  }

  const siteReady = await ensureFormSelectors(site);
  const selectors = siteReady.form_selectors || {};
  const formUrl = withMonitorParam(siteReady.quote_form_url || siteReady.main_url);
  const logoCandidates = await selectLogoCandidates(site.id);

  // Prefer the paid proxy pool when enabled. Never fall back to GitHub runner
  // IPs while the pool has capacity — those datacenter exits are already burned.
  selectedProxy = await selectFallbackProxy(site.id);
  let browser = await chromium.launch(
    getBrowserLaunchOptions(
      {
        headless: opts?.headed ? false : true,
        slowMo: opts?.headed ? 250 : 0,
      },
      selectedProxy?.launch ?? null
    )
  );
  let context = selectedProxy
    ? await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      })
    : null;
  if (selectedProxy && context) {
    proxyUsed = true;
    notes.push(`Attempt 1 uses ${selectedProxy.label} (sticky for this brand).`);
    const egress = await verifyProxyEgress(context);
    checkCountry = egress.country;
    checkIp = egress.ip;
    egressVerified = productionEgressRequired
      ? (egress.country || '').toUpperCase() === config.requiredCountry.toUpperCase() &&
        Boolean(egress.ip)
      : Boolean(egress.ip);
    if (!egressVerified) {
      monitorError = true;
      notes.push('Proxy egress was not verified in the required country.');
      await markProxyBlocked(selectedProxy, 'Unknown or non-US proxy egress', {
        persistCooldownMinutes: 60,
      });
    }
    console.log(
      `  proxy ${selectedProxy.label}: ${egress.country || 'unknown country'} / ${egress.ip || 'unknown IP'}`
    );
  }
  let page = context
    ? await context.newPage()
    : await browser.newPage({
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });
  let submittedAt = Date.now();

  try {
    let nav = await gotoWithRetries(page, formUrl, 1);
    if (selectedProxy) {
      fallbackStatus = nav.statusCode;
      notes.push(`Attempt 1 ${selectedProxy.label}: HTTP ${nav.statusCode ?? 'no response'}.`);
    } else {
      directStatus = nav.statusCode;
    }
    if (nav.note) notes.push(nav.note);
    let navigationBlocked =
      (selectedProxy && !egressVerified) ||
      nav.rateLimited ||
      (await pageLooksRateLimited(page));
    if (navigationBlocked && selectedProxy && (nav.rateLimited || (await pageLooksRateLimited(page)))) {
      await markProxyBlocked(selectedProxy, 'HTTP 429 from target');
    }

    if (navigationBlocked && selectedProxy) {
      const alternate = await selectAlternateProxy(site.id, selectedProxy.id);
      if (alternate) {
        notes.push(
          `Proxy path was rate-limited; retrying once via alternate ${alternate.label}.`
        );
        console.log(`  proxy form attempt was rate-limited; retrying via ${alternate.label}`);
        await browser.close();
        selectedProxy = alternate;
        proxyUsed = true;
        browser = await chromium.launch(
          getBrowserLaunchOptions(
            {
              headless: opts?.headed ? false : true,
              slowMo: opts?.headed ? 250 : 0,
            },
            alternate.launch
          )
        );
        const proxyContext = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'en-US',
          timezoneId: 'America/New_York',
        });
        const egress = await verifyProxyEgress(proxyContext);
        checkCountry = egress.country;
        checkIp = egress.ip;
        egressVerified = productionEgressRequired
          ? (egress.country || '').toUpperCase() === config.requiredCountry.toUpperCase() &&
            Boolean(egress.ip)
          : Boolean(egress.ip);
        if (!egressVerified) {
          monitorError = true;
          notes.push('Alternate proxy egress was not verified in the required country.');
          await markProxyBlocked(alternate, 'Unknown or non-US proxy egress', {
            persistCooldownMinutes: 60,
          });
        }
        console.log(
          `  alternate ${alternate.label}: ${egress.country || 'unknown country'} / ${egress.ip || 'unknown IP'}`
        );
        page = await proxyContext.newPage();
        nav = await gotoWithRetries(page, formUrl, 1);
        fallbackStatus = nav.statusCode;
        notes.push(`Attempt 2 ${alternate.label}: HTTP ${nav.statusCode ?? 'no response'}.`);
        if (nav.note) notes.push(nav.note);
        navigationBlocked =
          !egressVerified || nav.rateLimited || (await pageLooksRateLimited(page));
        if (navigationBlocked && (nav.rateLimited || (await pageLooksRateLimited(page)))) {
          await markProxyBlocked(alternate, 'HTTP 429 from target');
        }
      } else {
        notes.push(
          'No alternate proxy was available. Skipped GitHub direct egress while the paid proxy pool is enabled.'
        );
      }
    }

    if (navigationBlocked) {
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
        if (/name field fill failed|email field fill failed|phone field fill failed/i.test(notes.join(' '))) {
          throw new Error('Required contact fields were not filled successfully');
        }

        let fileInput = selectors.file
          ? page.locator(selectors.file).first()
          : page.locator('input[type="file"]').first();
        if ((await fileInput.count()) === 0) {
          logoUploadOk = false;
          notes.push('No file upload field detected');
        } else {
          logoUploadOk = await uploadLogoOnce(page, fileInput, logoCandidates[0]!, 1, notes)
            .catch(() => false);
        }

        if (logoUploadOk === false) {
          const firstShot = await captureFormScreenshot(
            page,
            `form_${site.name}_${runId}_logo_attempt_1`,
            'failure'
          );
          if (firstShot) attemptScreenshotPaths.push(firstShot);

          const refreshDelayMs = 15_000;
          notes.push(
            `Attempt 1 screenshot captured. Waiting ${refreshDelayMs / 1000} seconds, then refreshing the same browser session and IP.`
          );
          await page.waitForTimeout(refreshDelayMs);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
          const refreshedEgress = await verifyProxyEgress(page.context());
          if (checkIp && refreshedEgress.ip && refreshedEgress.ip !== checkIp) {
            monitorError = true;
            throw new Error(
              `Egress IP changed before logo retry (${checkIp} -> ${refreshedEgress.ip}); same-IP retry was not performed`
            );
          }
          notes.push(
            refreshedEgress.ip
              ? `Attempt 2: page refreshed and same egress IP verified (${refreshedEgress.ip}).`
              : `Attempt 2: page refreshed in the same browser session; egress re-verification was unavailable (${checkIp || 'original IP unknown'}).`
          );
          await page.waitForTimeout(2500);
          await openQuoteFormIfNeeded(page);
          await fillContactFields(page, identity, selectors, notes);
          if (/name field fill failed|email field fill failed|phone field fill failed/i.test(notes.join(' '))) {
            const fieldsShot = await captureFormScreenshot(
              page,
              `form_${site.name}_${runId}_logo_attempt_2_fields`,
              'failure'
            );
            if (fieldsShot) attemptScreenshotPaths.push(fieldsShot);
            throw new Error('Required contact fields were not filled after the logo-upload refresh');
          }

          fileInput = selectors.file
            ? page.locator(selectors.file).first()
            : page.locator('input[type="file"]').first();
          const retryLogo = logoCandidates[1] || logoCandidates[0]!;
          logoUploadOk =
            (await fileInput.count()) > 0
              ? await uploadLogoOnce(page, fileInput, retryLogo, 2, notes).catch(() => false)
              : false;
          const secondShot = await captureFormScreenshot(
            page,
            `form_${site.name}_${runId}_logo_attempt_2`,
            logoUploadOk ? 'success' : 'failure'
          );
          if (secondShot) attemptScreenshotPaths.push(secondShot);

          if (!logoUploadOk) {
            notes.push(
              'Attempt 2 logo upload still failed (often proxy/CDN network error, not home Wi-Fi).'
            );
            const fallbackUrl = site.main_url || 'https://beacon.test';
            if (await fillWebsiteOrBusinessFallback(page, fallbackUrl)) {
              notes.push(
                `Logo upload failed; filled website URL / business name fallback: ${fallbackUrl}`
              );
            } else {
              notes.push('Logo upload failed and website URL fallback field was not found.');
              throw new Error(
                'Required logo upload failed on both attempts, and website URL fallback could not be filled'
              );
            }
          } else {
            logoRecoveredAfterRefresh = true;
            notes.push('Attempt 2 succeeded after refreshing the page; continuing form submission.');
          }
        }

        notes.push(
          ...(await completeSignageQuoteSteps(page, message, {
            websiteUrl: site.main_url || 'https://beacon.test',
            forceWebsiteFallback: logoUploadOk === false,
          }))
        );
        if (/details field fill failed/i.test(notes.join(' '))) {
          throw new Error('Required details field was not filled');
        }
        await page.waitForTimeout(800);

        await clickQuoteSubmit(page, selectors.submit);
        submittedAt = Date.now();

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
    if (selectedProxy && /net::|proxy|tunnel|connection|timeout|browser.*closed/i.test(msg)) {
      await markProxyBlocked(selectedProxy, `Fallback execution failed: ${msg}`, {
        persistCooldownMinutes: 60,
      });
    }
    if (/429|rate.?limit|too many requests/i.test(msg) || (await pageLooksRateLimited(page))) {
      rateLimited = true;
      notes.push(`SKIPPED due to rate limit: ${msg}`);
    } else {
      const requiredFormControlFailed =
        /required form submit control|required contact fields|required logo upload|field fill failed/i.test(
          msg
        );
      if (requiredFormControlFailed) {
        layer1 = false;
        monitorError = false;
        notes.push(`Form requirement failed: ${msg}`);
      } else {
        monitorError = true;
        notes.push(`Form test failed to run: ${msg}`);
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
  if (
    screenshotPath &&
    !attemptScreenshotPaths.includes(screenshotPath)
  ) {
    attemptScreenshotPaths.push(screenshotPath);
  }

  await browser.close();

  // Rate-limited runs: leave layer1 null so dashboard does not treat as failed submit
  if (rateLimited) {
    layer1 = null;
    layer2 = null;
    logoUploadOk = null;
  }
  const outcome = classifyFormOutcome({
    statusCode: fallbackStatus ?? directStatus,
    submissionConfirmed: layer1 === true,
    rateLimitEvidence: rateLimited,
    monitorError: monitorError || layer1 === null,
    egressVerified,
  });

  await insertFormTest({
    site_id: site.id,
    run_id: runId,
    layer1_pass: layer1,
    layer2_pass: layer2,
    layer3_pass: layer3,
    submit_to_inbox_seconds: submitToInboxSeconds,
    logo_upload_ok: logoUploadOk,
    screenshot_path: screenshotPath,
    attempt_screenshot_paths: attemptScreenshotPaths,
    notes: notes.join(' | ') || null,
    is_production: geo.isProduction,
    check_country: checkCountry,
    check_ip: checkIp,
    outcome,
    workflow_run_id: getEnv('GITHUB_RUN_ID') || null,
    commit_sha: getEnv('GITHUB_SHA') || null,
    direct_status: directStatus,
    fallback_status: fallbackStatus,
    proxy_used: proxyUsed,
    egress_verified: egressVerified,
  });

  const submissionOnly = !isInboxVerificationEnabled();
  const anyFail =
    !monitorError && !rateLimited && (layer1 === false || (!submissionOnly && layer2 === false));

  if (logoRecoveredAfterRefresh) {
    await recordResolvedIncident({
      site_id: site.id,
      type: 'form_logo_upload_recovered',
      detail:
        `${site.name} logo upload failed on attempt 1. The monitor captured evidence, ` +
        `waited 15 seconds, refreshed the same browser session using IP ${checkIp || 'unknown'}, ` +
        `and attempt 2 succeeded with a different logo. Final form confirmation: ${layer1 === true ? 'passed' : 'not confirmed'}.`,
      screenshot_path: attemptScreenshotPaths[1] || screenshotPath,
      screenshot_paths: attemptScreenshotPaths,
    });
  }

  if (anyFail) {
    const id = await openIncident({
      site_id: site.id,
      type: 'form_test_failure',
      detail: `${site.name} form test failed. L1=${layer1} L2=${layer2}. ${notes.join(' ')}`,
      screenshot_path: screenshotPath,
      screenshot_paths: attemptScreenshotPaths,
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
    await closeIncident(site.id, 'form_check_failed_to_run');
  } else if (monitorError) {
    await openIncident({
      site_id: site.id,
      type: 'form_check_failed_to_run',
      detail: `${site.name} form monitor could not complete. ${notes.join(' ')}`,
      screenshot_path: screenshotPath,
      screenshot_paths: attemptScreenshotPaths,
    });
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
  siteId?: string | null;
}): Promise<number> {
  const sites = (await fetchActiveSites({ oneSite: opts.oneSite, siteId: opts.siteId })).filter(
    (s) => s.form_testing_enabled
  );
  if (sites.length === 0) {
    console.log('No sites with form testing enabled.');
    return 0;
  }

  const pauseMs = loadConfig().delayMsBetweenChecks ?? 12000;
  const abortAfter = getAbortAfterConsecutiveRateLimits();
  let consecutiveRateLimits = 0;
  let completedChecks = 0;

  console.log(`Form tests: waiting 20s before first site…`);
  await sleep(20_000);

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    console.log(`→ Form test ${site.name}…`);
    let result: { rateLimited: boolean; ok: boolean };
    try {
      result = await runFormTestForSite(site, opts.geo, { headed: opts.headed });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`  form monitor error: ${detail}`);
      await insertFormTest({
        site_id: site.id,
        run_id: buildRunId(),
        layer1_pass: null,
        layer2_pass: null,
        layer3_pass: null,
        submit_to_inbox_seconds: null,
        logo_upload_ok: null,
        screenshot_path: null,
        notes: `Form test failed to run: ${detail}`,
        is_production: opts.geo.isProduction,
        check_country: opts.geo.country,
        check_ip: opts.geo.ip,
        outcome: 'monitor_error',
        workflow_run_id: getEnv('GITHUB_RUN_ID') || null,
        commit_sha: getEnv('GITHUB_SHA') || null,
        egress_verified:
          opts.geo.deploymentMode !== 'production' ||
          (opts.geo.isUs && Boolean(opts.geo.ip)),
      });
      await openIncident({
        site_id: site.id,
        type: 'form_check_failed_to_run',
        detail,
      });
      result = { rateLimited: false, ok: false };
    }
    completedChecks += 1;
    if (result.rateLimited) {
      consecutiveRateLimits += 1;
      console.log(`  form rate-limit streak ${consecutiveRateLimits}/${abortAfter}`);
      if (consecutiveRateLimits >= abortAfter) {
        console.warn(
          `\n!!! ABORTING FORM TESTS — CDN rate-limited ${abortAfter} sites in a row. Stopping early.\n`
        );
        return completedChecks;
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
  return completedChecks;
}
