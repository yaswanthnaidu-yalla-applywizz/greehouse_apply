import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import config from '../src/config/env.js';
import {
  isWithinSubmissionQuestionLimit,
  isWithinSubmissionQuestionLimitForDisplay,
  assertWithinSubmissionQuestionLimit,
} from '../src/submission/questionLimit.js';

describe('submission question limit (removed)', () => {
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

  it('permits all question counts without cap', () => {
    assert.equal(
      isWithinSubmissionQuestionLimit({ field_count: config.MAX_JOB_QUESTIONS - 1 }).eligible,
      true
    );
    assert.equal(
      isWithinSubmissionQuestionLimit({ field_count: config.MAX_JOB_QUESTIONS }).eligible,
      true
    );
    assert.equal(
      isWithinSubmissionQuestionLimit({ field_count: 100 }).eligible,
      true
    );
    assert.equal(isWithinSubmissionQuestionLimit({}).eligible, true);
  });

  it('always marks eligible for display and live submission', () => {
    assert.equal(
      isWithinSubmissionQuestionLimitForDisplay({ field_count: config.MAX_JOB_QUESTIONS - 1 }),
      true
    );
    assert.equal(
      isWithinSubmissionQuestionLimitForDisplay({ field_count: config.MAX_JOB_QUESTIONS }),
      true
    );
    assert.equal(
      isWithinSubmissionQuestionLimitForDisplay({ field_count: 150 }),
      true
    );
  });

  it('assertWithinSubmissionQuestionLimit never throws', () => {
    assert.doesNotThrow(() =>
      assertWithinSubmissionQuestionLimit({ field_count: config.MAX_JOB_QUESTIONS })
    );
    assert.doesNotThrow(() =>
      assertWithinSubmissionQuestionLimit({ field_count: 999 })
    );
  });
});
