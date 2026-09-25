import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterOperatorApplicationJobs,
  isOperatorFormPanelBlocked,
  OPERATOR_SUBMITTABLE_APPLICATION_STATUSES,
  operatorFormBlockedDetailMessage,
  isUnresolvedApplicationJob,
  isSkippedApplicationJob,
} from '../src/dashboard/candidateQueueFilter.js';

describe('candidateQueueFilter', () => {
  it('filterOperatorApplicationJobs keeps SKIPPED and unresolved rows', () => {
    const jobs = [
      { status: 'SKIPPED', resolved_fields: [] },
      { status: 'READY_FOR_REVIEW', resolved_fields: [] },
      { status: 'APPLIED', resolved_fields: [{ source: 'supabase', resolvedByTier: 1 }] },
    ];
    assert.equal(filterOperatorApplicationJobs(jobs).length, 3);
  });

  it('isOperatorFormPanelBlocked follows submittable status whitelist', () => {
    assert.equal(isOperatorFormPanelBlocked('READY_FOR_REVIEW'), false);
    assert.equal(isOperatorFormPanelBlocked('APPLIED'), false);
    assert.equal(isOperatorFormPanelBlocked('SKIPPED'), true);
    assert.equal(isOperatorFormPanelBlocked('FAILED'), false);
    assert.equal(isOperatorFormPanelBlocked('RETRY'), false);
    assert.equal(isOperatorFormPanelBlocked('DRY_RUN_COMPLETE'), false);
    assert.equal(isOperatorFormPanelBlocked('EMAIL_PROOF_PENDING'), false);
  });

  it('operatorFormBlockedDetailMessage normalizes stored errors', () => {
    assert.match(operatorFormBlockedDetailMessage({ error_message: null, status: 'FAILED' }), /support/i);
    assert.match(
      operatorFormBlockedDetailMessage({ error_message: '46 fields (>= 35)', status: 'SKIPPED' }),
      /too many questions/i
    );
  });

  it('keeps retry applications in the operator form flow', () => {
    assert.equal(OPERATOR_SUBMITTABLE_APPLICATION_STATUSES.has('RETRY'), true);
  });

  it('isSkippedApplicationJob is case-insensitive', () => {
    assert.equal(isSkippedApplicationJob({ status: 'SKIPPED' }), true);
    assert.equal(isSkippedApplicationJob({ status: 'skipped' }), true);
    assert.equal(isSkippedApplicationJob({ status: 'PENDING' }), false);
  });

  it('isUnresolvedApplicationJob detects missing resolution and unresolved fields', () => {
    assert.equal(isUnresolvedApplicationJob({ status: 'SKIPPED' }), false);
    assert.equal(isUnresolvedApplicationJob({ status: 'PENDING', resolved_fields: [] }), true);
    assert.equal(isUnresolvedApplicationJob({ status: 'PENDING', fieldsCount: 8 }), false);
    assert.equal(
      isUnresolvedApplicationJob({
        status: 'READY_FOR_REVIEW',
        resolved_fields: [{ source: 'unresolved', resolvedByTier: null }],
      }),
      true
    );
    assert.equal(
      isUnresolvedApplicationJob({
        status: 'READY_FOR_REVIEW',
        resolved_fields: [{ source: 'supabase', resolvedByTier: 1 }],
      }),
      false
    );
    assert.equal(
      isUnresolvedApplicationJob({ status: 'READY_FOR_REVIEW', fieldsCount: 12 }),
      false
    );
  });
});
