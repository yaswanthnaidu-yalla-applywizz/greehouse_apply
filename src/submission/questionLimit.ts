import config from '../config/env.js';

export type SubmissionQuestionCount = {
  field_count?: number | null;
};

export class QuestionLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionLimitExceededError';
  }
}

export function isWithinSubmissionQuestionLimit(application: SubmissionQuestionCount): {
  eligible: boolean;
  reason?: string;
} {
  const fieldCount = application.field_count;
  if (fieldCount == null || !Number.isFinite(fieldCount)) {
    return {
      eligible: false,
      reason: 'Submission requires a known question count; re-run resolution to populate it.',
    };
  }
  if (fieldCount >= config.MAX_JOB_QUESTIONS) {
    return {
      eligible: false,
      reason: `Job has ${fieldCount} questions; submission requires fewer than ${config.MAX_JOB_QUESTIONS}.`,
    };
  }
  return { eligible: true };
}

export function assertWithinSubmissionQuestionLimit(application: SubmissionQuestionCount): void {
  const result = isWithinSubmissionQuestionLimit(application);
  if (!result.eligible) {
    throw new QuestionLimitExceededError(result.reason || 'Application exceeds the question limit.');
  }
}

export function isWithinSubmissionQuestionLimitForDisplay(
  application: SubmissionQuestionCount
): boolean {
  const fieldCount = application.field_count;
  return fieldCount != null && Number.isFinite(fieldCount) && fieldCount < config.MAX_JOB_QUESTIONS;
}
