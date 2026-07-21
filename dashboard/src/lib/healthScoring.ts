import type { FormTest, LoadCheck } from './types';

/**
 * Single source of truth for Reporting health calculations.
 *
 * Change these values later to tune the model. The Reporting methodology panel
 * reads this same object, so the explanation cannot drift away from the code.
 */
export const HEALTH_SCORING_CONFIG = {
  websiteWeights: {
    availability: 40,
    contentIntegrity: 25,
    performance: 20,
    browserCompatibility: 15,
  },
  performance: {
    fastMaxMs: 4000,
    acceptableMaxMs: 8000,
    fastScore: 100,
    acceptableScore: 70,
    slowScore: 30,
  },
  healthThresholds: {
    healthyMin: 90,
    attentionMin: 75,
  },
  confidenceThresholds: {
    highMin: 90,
    moderateMin: 70,
  },
  expectedProfiles: ['desktop', 'webkit', 'mobile'],
  formWeights: {
    contactFields: 20,
    logoUpload: 15,
    submissionConfirmation: 50,
    leadEmail: 15,
  },
} as const;

export type ScoreComponent = {
  score: number | null;
  weight: number;
  label: string;
  detail: string;
};

export type WebsiteHealthScore = {
  score: number | null;
  availability: ScoreComponent;
  contentIntegrity: ScoreComponent;
  performance: ScoreComponent;
  browserCompatibility: ScoreComponent;
  confidencePercent: number | null;
  confidenceLabel: 'High' | 'Moderate' | 'Low' | 'No data';
  assessedVisits: number;
  excludedRateLimits: number;
  observedProfiles: number;
  expectedProfiles: number;
};

export type FormHealthScore = {
  score: number | null;
  contactFields: ScoreComponent;
  logoUpload: ScoreComponent;
  submissionConfirmation: ScoreComponent;
  leadEmail: ScoreComponent;
  assessedForms: number;
  skippedForms: number;
};

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function ratioScore(passed: number, total: number): number | null {
  return total ? roundScore((passed / total) * 100) : null;
}

/** Only a definite HTTP 429 is excluded. A 503 is treated as site unavailability. */
export function isMonitorRateLimit(check: LoadCheck): boolean {
  return check.status_code === 429;
}

export function isAvailableVisit(check: LoadCheck): boolean {
  return (
    check.loaded === true &&
    check.status_code !== null &&
    check.status_code >= 200 &&
    check.status_code < 400
  );
}

export function performanceScoreForMs(loadMs: number): number {
  const { performance } = HEALTH_SCORING_CONFIG;
  if (loadMs <= performance.fastMaxMs) return performance.fastScore;
  if (loadMs <= performance.acceptableMaxMs) return performance.acceptableScore;
  return performance.slowScore;
}

function weightedScore(components: ScoreComponent[]): number | null {
  const available = components.filter(
    (component): component is ScoreComponent & { score: number } =>
      component.score !== null
  );
  const weight = available.reduce((sum, component) => sum + component.weight, 0);
  if (!weight) return null;
  return roundScore(
    available.reduce(
      (sum, component) => sum + component.score * component.weight,
      0
    ) / weight
  );
}

export function confidenceLabel(
  percent: number | null
): WebsiteHealthScore['confidenceLabel'] {
  if (percent === null) return 'No data';
  if (percent >= HEALTH_SCORING_CONFIG.confidenceThresholds.highMin) return 'High';
  if (percent >= HEALTH_SCORING_CONFIG.confidenceThresholds.moderateMin) {
    return 'Moderate';
  }
  return 'Low';
}

export function calculateWebsiteHealth(checks: LoadCheck[]): WebsiteHealthScore {
  const assessed = checks.filter((check) => !isMonitorRateLimit(check));
  const successful = assessed.filter(isAvailableVisit);
  const excludedRateLimits = checks.length - assessed.length;

  const availability: ScoreComponent = {
    score: ratioScore(successful.length, assessed.length),
    weight: HEALTH_SCORING_CONFIG.websiteWeights.availability,
    label: 'Availability',
    detail: `${successful.length} successful of ${assessed.length} assessed visits`,
  };

  const contentKeys = ['logo', 'headline', 'cta', 'quote_form'] as const;
  let contentAssertions = 0;
  let contentPasses = 0;
  for (const check of successful) {
    for (const key of contentKeys) {
      const value = check.elements_ok?.[key];
      if (typeof value !== 'boolean') continue;
      contentAssertions += 1;
      if (value) contentPasses += 1;
    }
  }
  const contentIntegrity: ScoreComponent = {
    score: ratioScore(contentPasses, contentAssertions),
    weight: HEALTH_SCORING_CONFIG.websiteWeights.contentIntegrity,
    label: 'Critical content',
    detail: contentAssertions
      ? `${contentPasses} of ${contentAssertions} logo/headline/CTA/form assertions passed`
      : 'No successful visits with content assertions',
  };

  const performanceSamples = successful
    .map((check) => check.load_ms)
    .filter((value): value is number => value !== null);
  const performance: ScoreComponent = {
    score: performanceSamples.length
      ? roundScore(
          performanceSamples.reduce(
            (sum, value) => sum + performanceScoreForMs(value),
            0
          ) / performanceSamples.length
        )
      : null,
    weight: HEALTH_SCORING_CONFIG.websiteWeights.performance,
    label: 'Performance',
    detail: performanceSamples.length
      ? `${performanceSamples.length} successful visits with load timing`
      : 'No successful visits with load timing',
  };

  const observedProfileScores = HEALTH_SCORING_CONFIG.expectedProfiles
    .map((profile) => {
      const rows = assessed.filter((check) => check.profile === profile);
      return rows.length
        ? ratioScore(rows.filter(isAvailableVisit).length, rows.length)
        : null;
    })
    .filter((value): value is number => value !== null);
  const browserCompatibility: ScoreComponent = {
    score: observedProfileScores.length
      ? roundScore(
          observedProfileScores.reduce((sum, value) => sum + value, 0) /
            observedProfileScores.length
        )
      : null,
    weight: HEALTH_SCORING_CONFIG.websiteWeights.browserCompatibility,
    label: 'Browser compatibility',
    detail: `${observedProfileScores.length} of ${HEALTH_SCORING_CONFIG.expectedProfiles.length} profiles assessed (Desktop, Safari, Mobile)`,
  };

  const assessmentCoverage = checks.length
    ? (assessed.length / checks.length) * 100
    : 0;
  const profileCoverage =
    (observedProfileScores.length / HEALTH_SCORING_CONFIG.expectedProfiles.length) *
    100;
  const confidencePercent = checks.length
    ? roundScore(assessmentCoverage * 0.7 + profileCoverage * 0.3)
    : null;

  const components = [
    availability,
    contentIntegrity,
    performance,
    browserCompatibility,
  ];

  return {
    score: assessed.length ? weightedScore(components) : null,
    availability,
    contentIntegrity,
    performance,
    browserCompatibility,
    confidencePercent,
    confidenceLabel: confidenceLabel(confidencePercent),
    assessedVisits: assessed.length,
    excludedRateLimits,
    observedProfiles: observedProfileScores.length,
    expectedProfiles: HEALTH_SCORING_CONFIG.expectedProfiles.length,
  };
}

export function isRateLimitedFormTest(test: FormTest): boolean {
  return /SKIPPED.*rate.?limit|CDN rate-limited|HTTP 429/i.test(test.notes || '');
}

function formBooleanScore(values: Array<boolean | null>): number | null {
  const known = values.filter((value): value is boolean => value !== null);
  return ratioScore(known.filter(Boolean).length, known.length);
}

export function calculateFormHealth(forms: FormTest[]): FormHealthScore {
  const assessed = forms.filter((form) => !isRateLimitedFormTest(form));
  const contactValues = assessed.map((form): boolean | null => {
    if (/name field fill failed|email field fill failed|phone field fill failed/i.test(form.notes || '')) {
      return false;
    }
    if (form.layer1_pass === true) return true;
    return null;
  });

  const contactFields: ScoreComponent = {
    score: formBooleanScore(contactValues),
    weight: HEALTH_SCORING_CONFIG.formWeights.contactFields,
    label: 'Contact fields',
    detail: 'Name, email and phone fields filled without a recorded failure',
  };
  const logoUpload: ScoreComponent = {
    score: formBooleanScore(assessed.map((form) => form.logo_upload_ok)),
    weight: HEALTH_SCORING_CONFIG.formWeights.logoUpload,
    label: 'Logo upload',
    detail: 'Test logo accepted by the form upload field',
  };
  const submissionConfirmation: ScoreComponent = {
    score: formBooleanScore(assessed.map((form) => form.layer1_pass)),
    weight: HEALTH_SCORING_CONFIG.formWeights.submissionConfirmation,
    label: 'Submission confirmation',
    detail: 'Submit completed and a thank-you/confirmation appeared',
  };
  const leadEmail: ScoreComponent = {
    score: formBooleanScore(assessed.map((form) => form.layer2_pass)),
    weight: HEALTH_SCORING_CONFIG.formWeights.leadEmail,
    label: 'Lead email',
    detail: 'Lead notification arrived when inbox verification was enabled',
  };

  return {
    score: weightedScore([
      contactFields,
      logoUpload,
      submissionConfirmation,
      leadEmail,
    ]),
    contactFields,
    logoUpload,
    submissionConfirmation,
    leadEmail,
    assessedForms: assessed.length,
    skippedForms: forms.length - assessed.length,
  };
}
