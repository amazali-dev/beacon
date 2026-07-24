/**
 * Auto-detects quote form fields using sensible signals
 * (input type, name, placeholder, label text).
 * Saves confirmed selectors into the sites table.
 */

import { chromium } from 'playwright';
import { fetchActiveSites, updateSiteSelectors } from '../db/supabase.js';
import { applyEsbuildNameShim, getBrowserLaunchOptions } from '../utils/browser.js';
import { blockHeavyAssets } from '../utils/bandwidth.js';
import { withMonitorParam } from '../utils/monitor-param.js';
import { openQuoteFormIfNeeded } from './form-fill-helpers.js';
import type { SiteRow } from '../types.js';
import {
  assertNotCancelled,
  emitJobEvent,
  isJobCancelledError,
} from '../jobs/progress.js';

export interface DetectionReport {
  siteId: string;
  siteName: string;
  fields: Record<string, { found: boolean; selector: string | null; note: string }>;
  plainEnglish: string[];
}

const FIELD_RULES: Array<{
  key: string;
  label: string;
  score: (el: {
    tag: string;
    type: string;
    name: string;
    id: string;
    placeholder: string;
    aria: string;
    labelText: string;
  }) => number;
}> = [
  {
    key: 'name',
    label: 'Name field',
    score: (el) => {
      const blob = `${el.name} ${el.id} ${el.placeholder} ${el.aria} ${el.labelText}`.toLowerCase();
      if (el.type === 'email' || el.type === 'tel' || el.type === 'file') return -10;
      if (/name|full.?name|first.?name|your.?name/.test(blob)) return 10;
      if (el.tag === 'input' && (el.type === 'text' || el.type === '')) return 2;
      return 0;
    },
  },
  {
    key: 'email',
    label: 'Email field',
    score: (el) => {
      const blob = `${el.name} ${el.id} ${el.placeholder} ${el.aria} ${el.labelText}`.toLowerCase();
      if (el.type === 'email') return 20;
      if (/e-?mail/.test(blob)) return 12;
      return 0;
    },
  },
  {
    key: 'phone',
    label: 'Phone field',
    score: (el) => {
      const blob = `${el.name} ${el.id} ${el.placeholder} ${el.aria} ${el.labelText}`.toLowerCase();
      if (el.type === 'tel') return 20;
      if (/phone|mobile|tel/.test(blob)) return 12;
      return 0;
    },
  },
  {
    key: 'message',
    label: 'Message / details field',
    score: (el) => {
      const blob = `${el.name} ${el.id} ${el.placeholder} ${el.aria} ${el.labelText}`.toLowerCase();
      if (el.tag === 'textarea') return 15;
      if (/message|details|comment|description|project/.test(blob)) return 10;
      return 0;
    },
  },
  {
    key: 'file',
    label: 'File upload',
    score: (el) => {
      if (el.type === 'file') return 20;
      return 0;
    },
  },
  {
    key: 'submit',
    label: 'Submit button',
    score: (el) => {
      const blob = `${el.name} ${el.id} ${el.placeholder} ${el.aria} ${el.labelText}`.toLowerCase();
      if (el.tag === 'button' || el.type === 'submit') {
        if (/submit|quote|send|get.?a.?quote|request|mockup/.test(blob)) return 15;
        if (el.type === 'submit') return 10;
        return 3;
      }
      return 0;
    },
  },
];

export async function detectFormFieldsForSite(site: SiteRow): Promise<DetectionReport> {
  const formUrl = site.quote_form_url || site.main_url;
  const url = withMonitorParam(formUrl);
  const browser = await chromium.launch(getBrowserLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await applyEsbuildNameShim(page);
  await blockHeavyAssets(page);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await openQuoteFormIfNeeded(page);

    const candidates = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll('input, textarea, button, [role="button"]')
      );
      return nodes.map((node, index) => {
        const el = node as HTMLInputElement;
        const id = el.id || '';
        let labelText = '';
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          labelText = lab?.textContent?.trim() || '';
        }
        if (!labelText) {
          const parentLabel = el.closest('label');
          labelText = parentLabel?.textContent?.trim() || '';
        }
        return {
          index,
          tag: el.tagName.toLowerCase(),
          type: (el.type || '').toLowerCase(),
          name: el.name || '',
          id,
          placeholder: el.placeholder || '',
          aria: el.getAttribute('aria-label') || '',
          labelText: labelText.slice(0, 120),
        };
      });
    });

    const formSelectors: Record<string, string> = {};
    const fields: DetectionReport['fields'] = {};
    const plainEnglish: string[] = [];
    const usedIndexes = new Set<number>();

    for (const rule of FIELD_RULES) {
      let best: { index: number; score: number } | null = null;
      for (const c of candidates) {
        if (usedIndexes.has(c.index)) continue;
        const score = rule.score(c);
        if (score > 0 && (!best || score > best.score)) {
          best = { index: c.index, score };
        }
      }

      if (best) {
        usedIndexes.add(best.index);
        const c = candidates[best.index];
        // Prefer stable Playwright-friendly selectors
        let selector: string;
        if (c.id) selector = `#${c.id}`;
        else if (c.name) selector = `${c.tag}[name="${c.name}"]`;
        else if (c.type === 'file') selector = 'input[type="file"]';
        else if (c.type === 'submit') selector = 'input[type="submit"], button[type="submit"]';
        else selector = `${c.tag} >> nth=${c.index}`;

        formSelectors[rule.key] = selector;
        fields[rule.key] = {
          found: true,
          selector,
          note: `Matched via ${c.tag}${c.type ? `[${c.type}]` : ''} name="${c.name}"`,
        };
        plainEnglish.push(`${rule.label}: found.`);
      } else {
        fields[rule.key] = { found: false, selector: null, note: 'Not detected' };
        plainEnglish.push(`${rule.label}: NOT found — needs attention.`);
      }
    }

    // Soft fallbacks for common missing pieces
    if (!formSelectors.submit) {
      formSelectors.submit =
        'button:has-text("Submit and Get Free Mockup"), button:has-text("Get my free mockup"), button:has-text("Get a Quote"), button[type="submit"], input[type="submit"], button:has-text("Submit")';
      fields.submit = {
        found: true,
        selector: formSelectors.submit,
        note: 'Fallback generic submit selector',
      };
      plainEnglish.push('Submit button: using generic fallback selector.');
    }

    await updateSiteSelectors(site.id, {
      form_selectors: formSelectors,
      form_detection_status: {
        checked_at: new Date().toISOString(),
        url,
        fields,
        plainEnglish,
        needsAttention: Object.values(fields).some((f) => !f.found),
      },
    });

    return {
      siteId: site.id,
      siteName: site.name,
      fields,
      plainEnglish,
    };
  } finally {
    await browser.close();
  }
}

export async function detectFormsForAllSites(opts?: {
  oneSite?: boolean;
  jobId?: string;
}): Promise<void> {
  const sites = await fetchActiveSites({ oneSite: opts?.oneSite });
  for (const site of sites) {
    await assertNotCancelled(opts?.jobId);
    console.log(`\nDetecting form fields for ${site.name}…`);
    await emitJobEvent(opts?.jobId, {
      phase: 'site_start',
      message: `Detecting ${site.name}`,
      siteId: site.id,
      siteName: site.name,
    });
    try {
      await emitJobEvent(opts?.jobId, {
        phase: 'step',
        message: 'Scanning form fields',
        siteId: site.id,
        siteName: site.name,
      });
      const report = await detectFormFieldsForSite(site);
      for (const line of report.plainEnglish) {
        console.log(`  ${line}`);
      }
      await emitJobEvent(opts?.jobId, {
        phase: 'step',
        message: 'Saved selectors',
        siteId: site.id,
        siteName: site.name,
      });
      await emitJobEvent(opts?.jobId, {
        phase: 'site_done',
        message: `${site.name} done`,
        siteId: site.id,
        siteName: site.name,
      });
    } catch (err) {
      if (isJobCancelledError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Detection failed to run: ${message}`);
      await emitJobEvent(opts?.jobId, {
        phase: 'error',
        message: message.slice(0, 300),
        siteId: site.id,
        siteName: site.name,
      });
      await updateSiteSelectors(site.id, {
        form_detection_status: {
          checked_at: new Date().toISOString(),
          error: message,
          needsAttention: true,
          plainEnglish: [`Detection failed to run: ${message}`],
        },
      });
    }
  }
}
