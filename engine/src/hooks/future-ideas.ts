/**
 * Future idea hooks — cheap stubs so we can flip them on later.
 * Do not implement fully yet.
 */

/** Idea 1: SSL + domain expiry watch (alert 21 days before). */
export async function checkSslAndDomainExpiry(_siteUrl: string): Promise<void> {
  // Hook only
}

/** Idea 3: Visual regression baseline / pixel compare. */
export async function visualRegressionHook(_siteId: string): Promise<void> {
  // Hook only
}

/** Idea 4: Third-party script watch (chat, reviews, pixels). */
export async function thirdPartyScriptWatch(_pageUrl: string): Promise<void> {
  // Hook only
}

/** Idea 5: Competitor load/LCP benchmark. */
export async function competitorBenchmarkHook(): Promise<void> {
  // Hook only
}

/** Idea 6: Weekly broken-link sweep. */
export async function brokenLinkSweepHook(_siteId: string): Promise<void> {
  // Hook only
}

/** Idea 7: Form friction timer (fill duration per field). */
export async function formFrictionTimerHook(_metrics: unknown): Promise<void> {
  // Hook only
}

/** Idea 8: Weekly trend email. */
export async function weeklyTrendEmailHook(): Promise<void> {
  // Hook only
}

/** Idea 9: Multi-region US checks. */
export async function multiRegionCheckHook(): Promise<void> {
  // Hook only
}

/** Idea 10: Checkout / currency (USD) watch. */
export async function checkoutCurrencyWatchHook(_siteUrl: string): Promise<void> {
  // Hook only
}
