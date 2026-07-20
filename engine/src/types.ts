/**
 * Shared TypeScript types for the monitoring engine.
 * Plain meaning: these describe the shape of our data.
 */

export type DeviceProfile = 'desktop' | 'webkit' | 'mobile';

export interface SiteRow {
  id: string;
  name: string;
  main_url: string;
  extra_urls: string[];
  quote_form_url: string | null;
  form_testing_enabled: boolean;
  selectors: Record<string, string>;
  form_selectors: Record<string, string>;
  form_detection_status: Record<string, unknown>;
  active: boolean;
}

export interface EngineConfig {
  loadCheckIntervalMinutes: number;
  formTestTimesEastern: string[];
  dailyReportTimeEastern: string;
  loadTimeThresholdMs: number;
  consecutiveSlowChecksBeforeAlert: number;
  alertCooldownHours: number;
  formLayer1TimeoutSeconds: number;
  formLayer2TimeoutMinutes: number;
  screenshotRetentionDays: number;
  monitorQueryParam: string;
  testIdentity: {
    name: string;
    email: string;
    phone: string;
    messageTemplate: string;
  };
  /** When false, only Layer 1 (form submits + thank-you page) is checked */
  formInboxVerificationEnabled: boolean;
  profiles: Record<
    DeviceProfile,
    {
      browser: 'chromium' | 'webkit' | 'firefox';
      viewport?: { width: number; height: number };
      device?: string;
    }
  >;
  geoCheckUrl: string;
  requiredCountry: string;
  /** staging = local NON-US test runs; production = GitHub Actions US runners */
  deploymentMode: 'staging' | 'production';
  stagingLabel: string;
  skipAlertsInStaging: boolean;
}

export interface GeoGuardResult {
  ok: boolean;
  isUs: boolean;
  country: string | null;
  ip: string | null;
  isProduction: boolean;
  /** staging or production — for logs and dashboard */
  deploymentMode: 'staging' | 'production';
  stagingLabel: string;
  warning: string | null;
}

export interface LoadCheckResult {
  siteId: string;
  profile: DeviceProfile;
  statusCode: number | null;
  loaded: boolean;
  loadMs: number | null;
  lcpMs: number | null;
  cls: number | null;
  consoleErrors: Array<{ type: string; text: string }>;
  failedRequests: Array<{ url: string; status: number | null; error?: string }>;
  elementsOk: Record<string, boolean>;
  screenshotPath: string | null;
  notes: string | null;
  failed: boolean;
}
