import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSubmittedApplicationJob } from '../src/dashboard/candidateQueueFilter.js';

describe('operator job-card status', () => {
  it('does not treat execution status as operator approval', () => {
    assert.equal(isSubmittedApplicationJob({ status: 'APPLIED' }), false);
    assert.equal(isSubmittedApplicationJob({ status: 'APPLYING' }), false);
    assert.equal(isSubmittedApplicationJob({ status: 'FAILED' }), false);
  });

  it('requires a persisted submission timestamp and ignores operator approval', () => {
    assert.equal(
      isSubmittedApplicationJob({
        status: 'READY_FOR_REVIEW',
        operator_approved_at: '2026-10-30T02:00:00.000Z',
      }),
      false
    );
    assert.equal(
      isSubmittedApplicationJob({
        status: 'READY_FOR_REVIEW',
        submitted_at: '2026-11-05T02:00:00.000Z',
      }),
      true
    );
    assert.equal(
      isSubmittedApplicationJob({
        status: 'APPLIED',
        submittedAt: '2026-11-05T02:00:00.000Z',
      }),
      true
    );
    assert.equal(
      isSubmittedApplicationJob({
        status: 'APPLIED',
        operator_approved_at: null,
        submitted_at: null,
      }),
      false
    );
  });
});
