import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import config from '../src/config/env.js';
import {
  computeEligibleForSubmissionDisplay,
  isEligibleForSubmission,
  parseCsvJobScore,
  SUBMISSION_SCORE_MAX,
  SUBMISSION_SCORE_MIN,
} from '../src/submission/submissionEligibilityGate.js';
import {
  getSubmissionEligibilityGateEnabled,
  setSubmissionEligibilityGateEnabled,
} from '../src/server/runtimeState.js';

describe('submissionEligibilityGate', () => {
  beforeEach(() => {
    setSubmissionEligibilityGateEnabled(true);
  });

  it('parseCsvJobScore handles numbers and strings', () => {
    assert.equal(parseCsvJobScore(42), 42);
    assert.equal(parseCsvJobScore('55.5'), 55.5);
    assert.equal(parseCsvJobScore(''), null);
  });

  it('computeEligibleForSubmissionDisplay uses score and field_count', () => {
    assert.equal(
      computeEligibleForSubmissionDisplay({ csv_job_score: 30, field_count: 10 }),
      true
    );
    assert.equal(
      computeEligibleForSubmissionDisplay({ csv_job_score: 10, field_count: 10 }),
      false
    );
    assert.equal(
      computeEligibleForSubmissionDisplay({
        csv_job_score: 30,
        field_count: config.MAX_JOB_QUESTIONS,
      }),
      false
    );
    assert.equal(
      computeEligibleForSubmissionDisplay({ csv_job_score: null, field_count: 10 }),
      false
    );
  });

  it('isEligibleForSubmission respects runtime gate toggle', () => {
    const app = { csv_job_score: 10, field_count: 10 };
    assert.equal(isEligibleForSubmission(app).eligible, false);
    setSubmissionEligibilityGateEnabled(false);
    assert.equal(isEligibleForSubmission(app).eligible, true);
    assert.equal(getSubmissionEligibilityGateEnabled(), false);
  });

  it('boundary scores at min and max', () => {
    assert.equal(
      isEligibleForSubmission({ csv_job_score: SUBMISSION_SCORE_MIN, field_count: 5 }).eligible,
      true
    );
    assert.equal(
      isEligibleForSubmission({ csv_job_score: SUBMISSION_SCORE_MAX, field_count: 5 }).eligible,
      true
    );
    assert.equal(
      isEligibleForSubmission({ csv_job_score: SUBMISSION_SCORE_MIN - 1, field_count: 5 }).eligible,
      false
    );
  });
});
