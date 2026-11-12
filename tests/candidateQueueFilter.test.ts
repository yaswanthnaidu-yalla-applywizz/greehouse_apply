import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterOperatorApplicationJobs,
  isOperatorFormPanelBlocked,
  OPERATOR_SUBMITTABLE_APPLICATION_STATUSES,
  operatorFormBlockedDetailMessage,
  isUnresolvedApplicationJob,
  isSkippedApplicationJob,
  isSubmittedApplicationJob,
  isAppliedApplicationJob,
  isFailedApplicationJob,
} from '../src/dashboard/candidateQueueFilter.js';

describe('candidateQueueFilter', () => {
  it('filterOperatorApplicationJobs excludes SKIPPED rows while keeping active rows', () => {
    const jobs = [
      { status: 'SKIPPED', resolved_fields: [] },
      { status: 'READY_FOR_REVIEW', resolved_fields: [] },
      { status: 'APPLIED', resolved_fields: [{ source: 'supabase', resolvedByTier: 1 }] },
    ];
    assert.equal(filterOperatorApplicationJobs(jobs).length, 1);
  });

  it('filterOperatorApplicationJobs excludes QUEUED and SKIPPED jobs while retaining other statuses', () => {
    const jobs = [
      { status: 'QUEUED', resolved_fields: [{ source: 'supabase', resolvedByTier: 1 }] },
      { status: 'queued', resolved_fields: [{ source: 'supabase', resolvedByTier: 1 }] },
      { status: 'READY_FOR_REVIEW', resolved_fields: [] },
      { status: 'SKIPPED', resolved_fields: [] },
      { status: 'APPLIED', resolved_fields: [{ source: 'supabase', resolvedByTier: 1 }] },
      { status: 'FAILED', resolved_fields: [] },
      { status: 'OTP_REQUIRED', resolved_fields: [] },
      { status: 'RETRY', resolved_fields: [] },
    ];
    const filtered = filterOperatorApplicationJobs(jobs);
    assert.equal(filtered.length, 3);
    assert.equal(filtered.some((j) => (j.status || '').toUpperCase() === 'QUEUED'), false);
    assert.equal(filtered.some((j) => (j.status || '').toUpperCase() === 'SKIPPED'), false);
    assert.equal(filtered.some((j) => (j.status || '').toUpperCase() === 'APPLIED'), false);
    assert.equal(filtered.some((j) => (j.status || '').toUpperCase() === 'FAILED'), false);
    assert.equal(filtered.some((j) => j.status === 'READY_FOR_REVIEW'), true);
  });

  it('excludes APPLIED jobs from operator queue', () => {
    const jobs = [
      { status: 'APPLIED', resolved_fields: [{ source: 'supabase' }] },
      { status: 'READY_FOR_REVIEW', resolved_fields: [{ source: 'supabase' }] },
    ];
    const filtered = filterOperatorApplicationJobs(jobs as any);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].status, 'READY_FOR_REVIEW');
  });

  it('excludes FAILED jobs from operator queue', () => {
    const jobs = [
      { status: 'FAILED', resolved_fields: [{ source: 'supabase' }] },
      { status: 'READY_FOR_REVIEW', resolved_fields: [{ source: 'supabase' }] },
    ];
    const filtered = filterOperatorApplicationJobs(jobs as any);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].status, 'READY_FOR_REVIEW');
  });

  it('isAppliedApplicationJob returns true for APPLIED and EMAIL_PROOF_PENDING', () => {
    assert.equal(isAppliedApplicationJob({ status: 'applied' }), true);
    assert.equal(isAppliedApplicationJob({ status: 'EMAIL_PROOF_PENDING' }), true);
    assert.equal(isAppliedApplicationJob({ status: 'READY_FOR_REVIEW' }), false);
  });

  it('isFailedApplicationJob returns true for FAILED', () => {
    assert.equal(isFailedApplicationJob({ status: 'FAILED' }), true);
    assert.equal(isFailedApplicationJob({ status: 'failed' }), true);
    assert.equal(isFailedApplicationJob({ status: null }), false);
    assert.equal(isFailedApplicationJob({ status: 'READY_FOR_REVIEW' }), false);
  });

  it('demo fixture APPLIED jobs not hidden when unrestricted', () => {
    // filterOperatorApplicationJobs is called after demo merge;
    // demo rows with status APPLIED should NOT appear in queue
    const demo = [{ status: 'APPLIED', resolved_fields: [{}] }];
    assert.equal(filterOperatorApplicationJobs(demo as any).length, 0);
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

  it('uses actual submission time for the job-card status', () => {
    assert.equal(isSubmittedApplicationJob({ operator_approved_at: '2026-10-30T00:00:00Z' }), false);
    assert.equal(isSubmittedApplicationJob({ submitted_at: '2026-10-30T00:00:00Z' }), true);
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
