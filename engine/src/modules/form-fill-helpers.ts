/**
 * Shared helpers for filling multi-step signage quote forms.
 */

import type { Locator, Page } from 'playwright';

export type ContactIdentity = {
  name: string;
  email: string;
  phone: string;
};

export async function openQuoteFormIfNeeded(page: Page): Promise<void> {
  const nameLike = page.locator(
    'input[name*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]'
  );
  if (await nameLike.first().isVisible({ timeout: 2500 }).catch(() => false)) {
    return;
  }

  const ctaPatterns = [
    /get free design mockup/i,
    /get your free quote/i,
    /get my free quote/i,
    /get a quote/i,
    /free quote/i,
    /request a quote/i,
    /get my free mockup/i,
    /start design/i,
  ];

  for (const pattern of ctaPatterns) {
    const cta = page
      .getByRole('link', { name: pattern })
      .or(page.getByRole('button', { name: pattern }));
    if (await cta.first().isVisible({ timeout: 1200 }).catch(() => false)) {
      await cta.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return;
    }
  }

  await page
    .locator('#quote, [id*="quote" i], [class*="quote-form" i], form')
    .first()
    .scrollIntoViewIfNeeded({ timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

export async function fillInput(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 8000 });
    await loc.click({ timeout: 5000 });
    await loc.fill('');
    await loc.fill(value, { timeout: 5000 });

    if (await fieldContainsValue(loc, value)) return true;

    await loc.click({ timeout: 3000 });
    await page.keyboard.press('Control+A');
    await loc.pressSequentially(value, { delay: 25 });
    return fieldContainsValue(loc, value);
  } catch {
    return false;
  }
}

async function fieldContainsValue(loc: Locator, value: string): Promise<boolean> {
  const actual = await loc.inputValue().catch(() => '');
  if (!actual) return false;
  if (actual === value) return true;
  if (value.includes('@') && actual.includes(value.split('@')[0]!)) return true;
  return actual.includes(value.slice(0, Math.min(6, value.length)));
}

async function tryFillLocator(loc: Locator, value: string): Promise<boolean> {
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
    await loc.click({ timeout: 5000 });
    await loc.fill('');
    await loc.fill(value, { timeout: 5000 });
    return fieldContainsValue(loc, value);
  } catch {
    return false;
  }
}

/** Finds an input/textarea near visible label text (works when labels aren't proper <label> elements). */
export async function fillInputNearLabel(
  page: Page,
  labelRe: RegExp,
  value: string,
  opts?: { maxLabelLength?: number; preferTextarea?: boolean }
): Promise<boolean> {
  const maxLabelLength = opts?.maxLabelLength ?? 40;
  const preferTextarea = opts?.preferTextarea ?? false;
  return page.evaluate(
    ({ pattern, val, maxLen, textareaOnly }) => {
      const re = new RegExp(pattern, 'i');
      const candidates = Array.from(
        document.querySelectorAll('label, span, p, div, h3, h4, legend, strong')
      );

      for (const el of candidates) {
        // Skip marketing headings — they often contain words like "Details".
        if (/^H[12]$/i.test(el.tagName)) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!re.test(text) || text.length > maxLen) continue;

        let root: Element | null =
          el.closest('div, fieldset, li, form, section') || el.parentElement;
        for (let depth = 0; depth < 5 && root; depth++) {
          const inputs = root.querySelectorAll(
            textareaOnly
              ? 'textarea'
              : 'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea'
          );
          for (const inp of inputs) {
            const input = inp as HTMLInputElement | HTMLTextAreaElement;
            const rect = input.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            input.focus();
            const proto =
              input instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            setter?.call(input, val);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
            const prefix = val.split('@')[0] || val;
            return input.value === val || input.value.includes(prefix);
          }
          root = root.parentElement;
        }
      }
      return false;
    },
    {
      pattern: labelRe.source,
      val: value,
      maxLen: maxLabelLength,
      textareaOnly: preferTextarea,
    }
  );
}

export async function fillDetailsField(page: Page, message: string): Promise<boolean> {
  const placeholderSelectors = [
    'textarea[placeholder*="budget" i]',
    'textarea[placeholder*="requirement" i]',
    'textarea[placeholder*="dimension" i]',
    'textarea[placeholder*="design" i]',
    'textarea[placeholder*="detail" i]',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="project" i]',
    'textarea[aria-label*="detail" i]',
    'textarea[aria-label*="message" i]',
    'textarea[name*="detail" i]',
    'textarea[name*="message" i]',
    'textarea[name*="project" i]',
    'textarea[name*="comment" i]',
    'textarea[id*="detail" i]',
    'textarea[id*="message" i]',
  ];

  for (const sel of placeholderSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
      if (await tryFillLocator(loc, message)) return true;
    }
  }

  // Short labels only — avoid matching page titles like "Submit Details for an Instant Quote".
  if (
    await fillInputNearLabel(page, /^(project\s+)?details?$/i, message, {
      maxLabelLength: 24,
      preferTextarea: true,
    })
  ) {
    return true;
  }

  if (
    await fillInputNearLabel(page, /^(project\s+)?(message|comments?|description)$/i, message, {
      maxLabelLength: 24,
      preferTextarea: true,
    })
  ) {
    return true;
  }

  const textareas = page.locator('form textarea, textarea');
  const count = await textareas.count();
  for (let i = 0; i < count; i++) {
    const loc = textareas.nth(i);
    if (!(await loc.isVisible({ timeout: 500 }).catch(() => false))) continue;
    if (await tryFillLocator(loc, message)) return true;
  }

  return false;
}

async function verifyEmailFilled(page: Page, email: string): Promise<boolean> {
  const prefix = email.split('@')[0]!;
  const inputs = page.locator(
    'input[type="email"], input[name*="email" i], input[placeholder*="mail" i], input[placeholder*="@" i]'
  );
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const val = await inputs.nth(i).inputValue().catch(() => '');
    if (val === email || val.includes(prefix)) return true;
  }
  return page.evaluate((expected) => {
    const prefix = expected.split('@')[0]!;
    for (const inp of document.querySelectorAll('input')) {
      const v = (inp as HTMLInputElement).value || '';
      if (v === expected || v.includes(prefix)) return true;
    }
    return false;
  }, email);
}

async function verifyNameFilled(page: Page, name: string): Promise<boolean> {
  const prefix = name.slice(0, Math.min(6, name.length));
  const inputs = page.locator(
    'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="email"]):not([type="tel"])'
  );
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const val = await inputs.nth(i).inputValue().catch(() => '');
    if (val === name || val.includes(prefix)) return true;
  }
  return page.evaluate((expected) => {
    const prefix = expected.slice(0, Math.min(6, expected.length));
    for (const inp of document.querySelectorAll('input')) {
      const input = inp as HTMLInputElement;
      if (['hidden', 'file', 'checkbox', 'radio', 'email', 'tel'].includes(input.type)) continue;
      const v = input.value || '';
      if (v === expected || v.includes(prefix)) return true;
    }
    return false;
  }, name);
}

export function phoneDigitsMatch(actual: string, expected: string): boolean {
  const actualDigits = actual.replace(/\D/g, '');
  const expectedDigits = expected.replace(/\D/g, '');
  if (!actualDigits || !expectedDigits) return false;
  const comparableLength = Math.min(10, expectedDigits.length);
  return actualDigits.endsWith(expectedDigits.slice(-comparableLength));
}

const PHONE_INPUT_SELECTOR = [
  'input[type="tel"]',
  'input[name*="phone" i]',
  'input[name*="mobile" i]',
  'input[id*="phone" i]',
  'input[id*="mobile" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="mobile" i]',
  'input[aria-label*="phone" i]',
  'input[aria-label*="mobile" i]',
  'input[inputmode="tel"]',
].join(', ');

async function verifyPhoneFilled(page: Page, phone: string): Promise<boolean> {
  const inputs = page.locator(PHONE_INPUT_SELECTOR);
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const value = await inputs.nth(i).inputValue().catch(() => '');
    if (phoneDigitsMatch(value, phone)) return true;
  }
  return false;
}

export async function fillPhoneField(
  page: Page,
  phone: string,
  selector?: string
): Promise<boolean> {
  const attempts: Array<() => Promise<boolean>> = [];
  if (selector) attempts.push(() => fillInput(page, selector, phone));
  attempts.push(
    () => tryFillLocator(page.getByPlaceholder(/phone|mobile|contact number/i).first(), phone),
    () => tryFillLocator(page.getByLabel(/phone|mobile|contact number/i).first(), phone),
    () => tryFillLocator(page.locator(PHONE_INPUT_SELECTOR).first(), phone),
    () => fillInputNearLabel(page, /phone|mobile|contact number/i, phone)
  );

  for (const attempt of attempts) {
    // Phone widgets commonly reformat raw digits (for example,
    // 5555551234 -> (555) 555-1234). The generic fill helper may report
    // false even though the controlled field visibly contains the number,
    // so always perform the digit-aware verification after each attempt.
    await attempt().catch(() => false);
    if (await verifyPhoneFilled(page, phone)) return true;
  }
  return false;
}

export async function fillNameField(page: Page, name: string, selector?: string): Promise<boolean> {
  const attempts: Array<() => Promise<boolean>> = [];

  if (selector) {
    attempts.push(() => fillInput(page, selector, name));
  }

  attempts.push(
    () => tryFillLocator(page.getByLabel(/^name/i).first(), name),
    () =>
      tryFillLocator(
        page
          .locator('input[name*="name" i]:not([type="email"]):not([type="tel"])')
          .first(),
        name
      ),
    () => tryFillLocator(page.getByPlaceholder(/your name|full name|^name$/i).first(), name),
    () => fillInputNearLabel(page, /^name\s*\*?$/i, name),
    () => fillInputNearLabel(page, /your name|full name/i, name)
  );

  for (const attempt of attempts) {
    if (await attempt().catch(() => false)) {
      if (await verifyNameFilled(page, name)) return true;
    }
  }
  return false;
}

export async function fillEmailField(page: Page, email: string, selector?: string): Promise<boolean> {
  const attempts: Array<() => Promise<boolean>> = [];

  if (selector) {
    attempts.push(() => fillInput(page, selector, email));
  }

  attempts.push(
    () => tryFillLocator(page.getByPlaceholder(/example@mail|you@|email|@/i).first(), email),
    () => tryFillLocator(page.locator('input[type="email"]').first(), email),
    () => tryFillLocator(page.getByLabel(/^email/i).first(), email),
    () => fillInputNearLabel(page, /^email\s*\*?$/i, email),
    () => fillInputNearLabel(page, /email/i, email)
  );

  for (const attempt of attempts) {
    if (await attempt().catch(() => false)) {
      if (await verifyEmailFilled(page, email)) return true;
    }
  }
  return false;
}

export async function fillContactFields(
  page: Page,
  identity: ContactIdentity,
  selectors: Record<string, string>,
  notes: string[]
): Promise<void> {
  const nameOk = await fillNameField(page, identity.name, selectors.name);
  if (!nameOk) notes.push('Name field fill failed');

  const emailOk = await fillEmailField(page, identity.email, selectors.email);
  if (!emailOk) notes.push('Email field fill failed');

  const phoneOk = await fillPhoneField(page, identity.phone, selectors.phone);
  if (!phoneOk) notes.push('Phone field fill failed');
}

export async function completeSignageQuoteSteps(
  page: Page,
  message: string
): Promise<string[]> {
  const notes: string[] = [];

  // Placements — check BOTH indoor and outdoor when they are checkboxes
  for (const label of ['Indoor', 'Outdoor']) {
    const checkbox = page.getByRole('checkbox', { name: new RegExp(label, 'i') }).first();
    if (await checkbox.isVisible({ timeout: 1200 }).catch(() => false)) {
      await checkbox.check({ timeout: 5000 }).catch(async () => {
        await page.getByText(label, { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
      });
      notes.push(`Checked placement: ${label}`);
      continue;
    }

    const btn = page
      .getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
      .or(page.getByText(label, { exact: true }))
      .first();
    if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      notes.push(`Selected placement: ${label}`);
    }
  }

  // Mockup / sign type — pick first visible option
  const signTypes = [
    'Halo Lit',
    '3D Metal Back-lit',
    '3D Metal Backlit',
    'Face Lit',
    'Acrylic Front-lit',
    '3D Blade Sign',
    'Lightbox',
    'Flat Cut',
    'Flat Cut Letters',
    '3D Frontlit',
    'Fabricated',
    'Push Through',
    'Channel Letter',
    'Monument',
  ];

  for (const typeName of signTypes) {
    const card = page.getByText(typeName, { exact: false }).first();
    if (await card.isVisible({ timeout: 800 }).catch(() => false)) {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.click({ timeout: 5000 }).catch(() => {});
      notes.push(`Selected mockup type: ${typeName}`);
      break;
    }
  }

  // Size option
  for (const sizeLabel of ['Recommended', 'Custom']) {
    const size = page.getByText(sizeLabel, { exact: true }).first();
    if (await size.isVisible({ timeout: 800 }).catch(() => false)) {
      await size.click({ timeout: 3000 }).catch(() => {});
      notes.push(`Selected size: ${sizeLabel}`);
      break;
    }
  }

  // Details / message — must target the real textarea, not page titles like
  // "Submit Details for an Instant Quote" (that bug overwrote the name field).
  if (await fillDetailsField(page, message)) {
    notes.push('Filled details');
  } else {
    notes.push('Details field fill failed');
  }

  // Website address (Signage.inc requires this)
  if (await fillInputNearLabel(page, /website/i, 'https://beacon.test')) {
    notes.push('Filled website address');
  }

  return notes;
}

export const QUOTE_SUBMIT_TEXT =
  /submit(?:\s+now)?|submit.*mockups?|(?:get|request).*mockups?|(?:get|request).*quotes?/i;

export async function clickQuoteSubmit(page: Page, selector?: string): Promise<void> {
  if (selector) {
    const configured = page.locator(selector).first();
    if (await configured.isVisible({ timeout: 1500 }).catch(() => false)) {
      await configured.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await page
        .getByText(/uploading/i)
        .first()
        .waitFor({ state: 'hidden', timeout: 30000 })
        .catch(() => {});
      await configured.click({ timeout: 30000 });
      return;
    }
  }

  const form = page.locator('form:visible').first();
  const candidates = [
    form.getByRole('button', { name: QUOTE_SUBMIT_TEXT }).first(),
    page.getByRole('button', { name: QUOTE_SUBMIT_TEXT }).first(),
    form
      .locator('button, [role="button"], a')
      .filter({ hasText: QUOTE_SUBMIT_TEXT })
      .first(),
    page
      .locator('button, [role="button"], a')
      .filter({ hasText: QUOTE_SUBMIT_TEXT })
      .first(),
    form.locator('button[type="submit"], input[type="submit"]').first(),
    page.locator('button[type="submit"], input[type="submit"]').first(),
  ];

  for (const btn of candidates) {
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      // File-upload widgets may keep the final CTA disabled while the image is uploading.
      await page
        .getByText(/uploading/i)
        .first()
        .waitFor({ state: 'hidden', timeout: 30000 })
        .catch(() => {});
      await btn.click({ timeout: 30000 });
      return;
    }
  }

  throw new Error(
    'Required form submit control was not found or visible (expected Submit, Submit Now, Get Mockup, Get Free Mockup, or equivalent).'
  );
}

export async function waitForThankYou(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await Promise.race([
      page.waitForURL(/thank|success|confirm|received/i, { timeout: timeoutMs }),
      page
        .locator(
          'text=/thank you|we.?ve received|we.?received|submitted|success|quote.?request|thank you, friend|request is on|already working on it|expect a call/i'
        )
        .first()
        .waitFor({ timeout: timeoutMs }),
    ]);
    return true;
  } catch {
    return false;
  }
}
