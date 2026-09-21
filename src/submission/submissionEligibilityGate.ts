/**
 * Submission eligibility gate — score 20–60 and field_count < MAX_JOB_QUESTIONS when enabled.
 */

import config from '../config/env.js';
import {
  getSubmissionEligibilityGateEnabled,
  setSubmissionEligibilityGateEnabled,
  refreshSubmissionEligibilityGateFromDb,
} from '../server/runtimeState.js';

export {
  getSubmissionEligibilityGateEnabled,
  setSubmissionEligibilityGateEnabled,
  refreshSubmissionEligibilityGateFromDb,
};

export type SubmissionEligibilityInput = {
  csv_job_score?: number | null;
  field_count?: number | null;
};

export const SUBMISSION_SCORE_MIN = 20;
export const SUBMISSION_SCORE_MAX = 60;

export class SubmissionEligibilityBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionEligibilityBlockedError';
  }
}

export function parseCsvJobScore(score: string | number | null | undefined): number | null {
  if (score === undefined || score === null || score === '') return null;
  if (typeof score === 'number') return Number.isFinite(score) ? score : null;
  const parsed = parseFloat(String(score).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function isCsvJobScoreInSubmissionRange(score: number | null | undefined): boolean {
  if (score == null || !Number.isFinite(score)) return false;
  return score >= SUBMISSION_SCORE_MIN && score <= SUBMISSION_SCORE_MAX;
}

export function submissionGateCriteria() {
  return {
    minScore: SUBMISSION_SCORE_MIN,
    maxScore: SUBMISSION_SCORE_MAX,
    maxFieldCountExclusive: config.MAX_JOB_QUESTIONS,
  };
}

export function isEligibleForSubmission(app: SubmissionEligibilityInput): {
  eligible: boolean;
  reason?: string;
} {
  if (!getSubmissionEligibilityGateEnabled()) {
    return { eligible: true };
  }

  const score = parseCsvJobScore(app.csv_job_score);
  if (!isCsvJobScoreInSubmissionRange(score)) {
    return {
      eligible: false,
      reason: `Submission gate: job score must be ${SUBMISSION_SCORE_MIN}–${SUBMISSION_SCORE_MAX} (got ${score ?? 'missing'}). A dev can turn the gate off on the Dev dashboard.`,
    };
  }

  const fieldCount = app.field_count;
  if (fieldCount == null || !Number.isFinite(fieldCount)) {
    return {
      eligible: false,
      reason:
        'Submission gate: field count is missing on this application (re-run resolve after migration 019). A dev can turn the gate off on the Dev dashboard.',
    };
  }
  if (fieldCount >= config.MAX_JOB_QUESTIONS) {
    return {
      eligible: false,
      reason: `Submission gate: job has ${fieldCount} questions (must be fewer than ${config.MAX_JOB_QUESTIONS}). A dev can turn the gate off on the Dev dashboard.`,
    };
  }

  return { eligible: true };
}

export function assertEligibleForSubmission(app: SubmissionEligibilityInput): void {
  const result = isEligibleForSubmission(app);
  if (!result.eligible) {
    throw new SubmissionEligibilityBlockedError(result.reason || 'Submission gate blocked this application.');
  }
}

/** Criteria-only check for dashboard badges (independent of runtime gate toggle). */
export function computeEligibleForSubmissionDisplay(app: SubmissionEligibilityInput): boolean {
  const score = parseCsvJobScore(app.csv_job_score);
  const fieldCount = app.field_count;
  if (!isCsvJobScoreInSubmissionRange(score)) return false;
  if (fieldCount == null || fieldCount >= config.MAX_JOB_QUESTIONS) return false;
  return true;
}
