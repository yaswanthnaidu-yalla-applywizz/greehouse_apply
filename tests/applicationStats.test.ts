import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveApplicationStatsRange,
  isApplicationStatsRangeAvailable,
  resolveStatsScope,
  summarizeOperatorStatRows,
  statusMetricsForTransition,
  summarizeApplicationStatRows,
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
    assert.deepEqual(statusMetricsForTransition('CAPTCHA_TIMEOUT'), ['submitted']);
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

    it('deduplicates operator counts per application, day, and metric while preserving event-time owners', () => {
      const rows = [
        { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca-a@example.com' },
        { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca-a@example.com' },
        { event_date: '2026-10-07', application_id: 'app-1', applywizz_id: 'AWL-1', metric: 'submitted' as const, ca_email: 'ca-b@example.com' },
      ];
      assert.deepEqual(summarizeOperatorStatRows(rows), [
        { email: 'ca-a@example.com', total: 0, submitted: 1, applied: 0, failed: 0 },
        { email: 'ca-b@example.com', total: 0, submitted: 1, applied: 0, failed: 0 },
      ]);
    });
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
});
