import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOperatorApprovedApplicationJob } from '../src/dashboard/candidateQueueFilter.js';

describe('operator job-card status', () => {
  it('does not treat execution status as operator approval', () => {
    assert.equal(isOperatorApprovedApplicationJob({ status: 'APPLIED' }), false);
    assert.equal(isOperatorApprovedApplicationJob({ status: 'APPLYING' }), false);
    assert.equal(isOperatorApprovedApplicationJob({ status: 'FAILED' }), false);
  });

  it('treats only the explicit approval timestamp as submitted', () => {
    assert.equal(
      isOperatorApprovedApplicationJob({
        status: 'READY_FOR_REVIEW',
        operator_approved_at: '2026-10-30T02:00:00.000Z',
      }),
      true
    );
    assert.equal(
      isOperatorApprovedApplicationJob({
        status: 'APPLIED',
        operator_approved_at: null,
      }),
      false
    );
  });
});
