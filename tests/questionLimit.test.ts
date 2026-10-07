import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import config from '../src/config/env.js';
import {
  isWithinSubmissionQuestionLimit,
  isWithinSubmissionQuestionLimitForDisplay,
  assertWithinSubmissionQuestionLimit,
  QuestionLimitExceededError,
} from '../src/submission/questionLimit.js';

describe('submission question limit', () => {
  it('does not restrict submissions based on CSV job score', () => {
    const lowScoreApplication = { field_count: 10, csv_job_score: -100 };
    const unscoredApplication = { field_count: 10, csv_job_score: null };
    assert.deepEqual(
      isWithinSubmissionQuestionLimit(lowScoreApplication),
      { eligible: true }
    );
    assert.deepEqual(
      isWithinSubmissionQuestionLimit(unscoredApplication),
      { eligible: true }
    );
  });

  it('enforces the existing question-count cap', () => {
    assert.equal(
      isWithinSubmissionQuestionLimit({ field_count: config.MAX_JOB_QUESTIONS - 1 }).eligible,
      true
    );
    assert.equal(
      isWithinSubmissionQuestionLimit({ field_count: config.MAX_JOB_QUESTIONS }).eligible,
      false
    );
    assert.equal(isWithinSubmissionQuestionLimit({}).eligible, false);
  });

  it('uses the same question-count cap for display and live submission', () => {
    assert.equal(
      isWithinSubmissionQuestionLimitForDisplay({ field_count: config.MAX_JOB_QUESTIONS - 1 }),
      true
    );
    assert.equal(
      isWithinSubmissionQuestionLimitForDisplay({ field_count: config.MAX_JOB_QUESTIONS }),
      false
    );
  });

  it('surfaces an explicit error when the question limit blocks submission', () => {
    assert.throws(
      () => assertWithinSubmissionQuestionLimit({ field_count: config.MAX_JOB_QUESTIONS }),
      QuestionLimitExceededError
    );
  });
});
