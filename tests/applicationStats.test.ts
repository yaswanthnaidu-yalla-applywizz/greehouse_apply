import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveApplicationStatsRange,
  isApplicationStatsRangeAvailable,
  resolveStatsScope,
  summarizeOperatorStatRows,
  statusMetricsForTransition,
  summarizeApplicationStatRows,
  summarizeApplicationCohortRows,
  summarizeApplicationTrend,
  ApplicationCohortRow,
} from '../src/db/applicationStats.js';

describe('application statistics contract', () => {
  it('maps all confirmed status transitions to their metrics', () => {
    assert.deepEqual(statusMetricsForTransition('READY_FOR_REVIEW'), []);
    assert.deepEqual(statusMetricsForTransition('SKIPPED'), []);
    assert.deepEqual(statusMetricsForTransition('APPROVED'), ['submitted']);
    assert.deepEqual(statusMetricsForTransition('DRY_RUN_COMPLETE'), ['submitted']);
    assert.deepEqual(statusMetricsForTransition('EXPIRED'), ['submitted']);
    assert.deepEqual(statusMetricsForTransition('QUEUED'), ['submitted']);
    assert.deepEqual(statusMetricsForTransition('APPLIED'), ['submitted', 'applied']);
    assert.deepEqual(statusMetricsForTransition('EMAIL_PROOF_PENDING'), ['submitted', 'applied']);
    assert.deepEqual(statusMetricsForTransition('FAILED'), ['submitted', 'failed']);
    assert.deepEqual(statusMetricsForTransition('RETRY'), ['submitted']);
  });

  it('resolves global, manager, CA, and manager-plus-CA scopes', () => {
    assert.deepEqual(resolveStatsScope({}), { scopeType: 'global', scopeKey: '' });
    assert.deepEqual(resolveStatsScope({ managerEmail: ' M@Example.com ' }), {
      scopeType: 'manager',
      scopeKey: 'm@example.com',
    });
    assert.deepEqual(resolveStatsScope({ caEmail: ' CA@Example.com ' }), {
      scopeType: 'ca',
      scopeKey: 'ca@example.com',
    });
    assert.deepEqual(resolveStatsScope({
      managerEmail: 'M@Example.com',
      caEmail: 'CA@Example.com',
    }), {
      scopeType: 'manager_ca',
      scopeKey: 'm@example.com|ca@example.com',
    });
  });

  it('counts an application once per metric per day but again on another day', () => {
    const rows = [
      { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca@example.com' },
      { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca@example.com' },
      { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'applied' as const, ca_email: 'ca@example.com' },
      { event_date: '2026-10-08', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca@example.com' },
      { event_date: '2026-10-08', application_id: 'app-2', applywizz_id: 'AWL-1', metric: 'total' as const, ca_email: 'ca@example.com' },
    ];

    const result = summarizeApplicationStatRows(rows);
    assert.deepEqual(result.counts, { total: 1, submitted: 2, applied: 1, failed: 0 });
    assert.deepEqual(result.byCandidate[0], {
      applywizzId: 'AWL-1',
      total: 1,
      submitted: 2,
      applied: 1,
      failed: 0,
      caEmails: ['ca@example.com'],
    });

    const opRows = [
      { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca-a@example.com' },
      { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca-a@example.com' },
      { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca-b@example.com' },
    ];
    assert.deepEqual(summarizeOperatorStatRows(opRows), [
      { email: 'ca-a@example.com', total: 0, submitted: 1, applied: 0, failed: 0 },
      { email: 'ca-b@example.com', total: 0, submitted: 1, applied: 0, failed: 0 },
    ]);
    assert.equal(result.byDate.length, 2);
  });

  it('makes overlapping ranges available for the post-cutover portion only', () => {
    const range = { fromDate: '2026-10-06', toDate: '2026-10-07' };
    assert.equal(isApplicationStatsRangeAvailable(range, '2026-10-07'), true);
    assert.deepEqual(effectiveApplicationStatsRange(range, '2026-10-07'), {
      range: { fromDate: '2026-10-07', toDate: '2026-10-07' },
      partial: true,
    });
    assert.equal(isApplicationStatsRangeAvailable(
      { fromDate: '2026-10-06', toDate: '2026-10-06' },
      '2026-10-07'
    ), false);
    assert.equal(effectiveApplicationStatsRange(
      { fromDate: '2026-10-06', toDate: '2026-10-06' },
      '2026-10-07'
    ), null);
    assert.equal(isApplicationStatsRangeAvailable(
      { fromDate: '2026-10-07', toDate: '2026-10-07' },
      '2026-10-07'
    ), true);
    assert.deepEqual(effectiveApplicationStatsRange(
      { fromDate: '2026-10-07', toDate: '2026-10-07' },
      '2026-10-07'
    ), {
      range: { fromDate: '2026-10-07', toDate: '2026-10-07' },
      partial: false,
    });
  });

  it('cohort counts an application created Monday, failed Tuesday, and retried to APPLIED on Wednesday as Monday success and zero failure', () => {
    // Created Monday 2026-10-26, retried Wednesday 2026-10-28 to APPLIED
    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-retry-1',
        applywizz_id: 'AWL-101',
        status: 'APPLIED',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-26T04:30:00.000Z', // Monday 10:00 IST
        first_attempted_at: '2026-10-26T06:00:00.000Z',
      },
    ];
    const summary = summarizeApplicationCohortRows(rows);
    assert.deepEqual(summary.counts, {
      total: 1,
      submitted: 1,
      applied: 1,
      failed: 0,
    });
    assert.equal(summary.byCandidate.length, 1);
    assert.equal(summary.byCandidate[0].applywizzId, 'AWL-101');
    assert.equal(summary.byCandidate[0].applied, 1);
    assert.equal(summary.byCandidate[0].failed, 0);
  });

  it('cohort counts both APPLIED and EMAIL_PROOF_PENDING as success', () => {
    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-applied',
        applywizz_id: 'AWL-1',
        status: 'APPLIED',
        assigned_ca_email: 'ca1@example.com',
        created_at: '2026-10-28T04:00:00.000Z',
        first_attempted_at: '2026-10-28T04:05:00.000Z',
      },
      {
        id: 'app-proof-pending',
        ats: 'ashby',
        applywizz_id: 'AWL-2',
        status: 'EMAIL_PROOF_PENDING',
        assigned_ca_email: 'ca2@example.com',
        created_at: '2026-10-28T05:00:00.000Z',
        first_attempted_at: '2026-10-28T05:05:00.000Z',
      },
      {
        id: 'app-failed',
        applywizz_id: 'AWL-3',
        status: 'FAILED',
        assigned_ca_email: 'ca1@example.com',
        created_at: '2026-10-28T06:00:00.000Z',
        first_attempted_at: '2026-10-28T06:05:00.000Z',
      },
      {
        id: 'app-unattempted',
        applywizz_id: 'AWL-4',
        status: 'READY_FOR_REVIEW',
        assigned_ca_email: 'ca2@example.com',
        created_at: '2026-10-28T07:00:00.000Z',
      },
    ];
    const summary = summarizeApplicationCohortRows(rows);
    assert.deepEqual(summary.counts, {
      total: 4,
      submitted: 3,
      applied: 2,
      failed: 1,
    });
    assert.deepEqual(summary.byAts, {
      greenhouse: { total: 3, submitted: 2, applied: 1, failed: 1 },
      ashby: { total: 1, submitted: 1, applied: 1, failed: 0 },
    });
  });

  it('cohort retains first attempt submitted count after later status change to unattempted', () => {
    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-returned-to-rfr',
        applywizz_id: 'AWL-5',
        status: 'READY_FOR_REVIEW',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-27T08:00:00.000Z',
        first_attempted_at: '2026-10-27T09:00:00.000Z', // marked as attempted earlier
      },
    ];
    const summary = summarizeApplicationCohortRows(rows);
    assert.equal(summary.counts.total, 1);
    assert.equal(summary.counts.submitted, 1);
    assert.equal(summary.counts.applied, 0);
    assert.equal(summary.counts.failed, 0);
  });

  it('trend aggregates multiple jobs for one candidate to single client count in bucket', () => {
    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-1',
        applywizz_id: 'AWL-MULTI',
        status: 'APPLIED',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-26T04:00:00.000Z', // Monday IST
        first_attempted_at: '2026-10-26T04:10:00.000Z',
      },
      {
        id: 'app-2',
        applywizz_id: 'AWL-MULTI',
        status: 'EMAIL_PROOF_PENDING',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-26T06:00:00.000Z', // Monday IST
        first_attempted_at: '2026-10-26T06:10:00.000Z',
      },
      {
        id: 'app-3',
        applywizz_id: 'AWL-OTHER',
        status: 'FAILED',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-26T07:00:00.000Z', // Monday IST
        first_attempted_at: '2026-10-26T07:10:00.000Z',
      },
    ];
    const trend = summarizeApplicationTrend(rows, {
      range: { fromDate: '2026-10-26', toDate: '2026-10-26' },
      bucket: 'day',
    });
    assert.equal(trend.length, 1);
    assert.equal(trend[0].bucketStart, '2026-10-26');
    assert.equal(trend[0].successApplications, 2);
    assert.equal(trend[0].failedApplications, 1);
    assert.equal(trend[0].clients, 1); // Only AWL-MULTI was successful
  });

  it('trend outputs zero buckets for empty calendar periods in range', () => {
    // Range of 3 days: 2026-10-20 to 2026-10-22
    // Application only on 2026-10-21
    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-1',
        applywizz_id: 'AWL-SINGLE',
        status: 'APPLIED',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-21T05:00:00.000Z',
        first_attempted_at: '2026-10-21T05:10:00.000Z',
      },
    ];
    const trend = summarizeApplicationTrend(rows, {
      range: { fromDate: '2026-10-20', toDate: '2026-10-22' },
      bucket: 'day',
    });
    assert.equal(trend.length, 3);
    assert.deepEqual(trend[0], {
      bucketStart: '2026-10-20',
      successApplications: 0,
      failedApplications: 0,
      clients: 0,
    });
    assert.deepEqual(trend[1], {
      bucketStart: '2026-10-21',
      successApplications: 1,
      failedApplications: 0,
      clients: 1,
    });
    assert.deepEqual(trend[2], {
      bucketStart: '2026-10-22',
      successApplications: 0,
      failedApplications: 0,
      clients: 0,
    });
  });
});
