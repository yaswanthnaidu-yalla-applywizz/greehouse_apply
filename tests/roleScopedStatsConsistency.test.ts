import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getApplicationStats,
  getApplicationTrend,
  summarizeApplicationCohortRows,
  ApplicationCohortRow,
} from '../src/db/applicationStats.js';
import { parseDashboardStatsRange } from '../src/server/dashboardDateRange.js';

describe('role-scoped stats consistency contract', () => {
  it('yields identical totals at global scope across cohort aggregations', async () => {
    const testRows: ApplicationCohortRow[] = [
      {
        id: 'app-1',
        applywizz_id: 'AWL-1',
        status: 'APPLIED',
        assigned_ca_email: 'op1@example.com',
        created_at: '2026-10-28T04:00:00.000Z',
        first_attempted_at: '2026-10-28T04:10:00.000Z',
      },
      {
        id: 'app-2',
        applywizz_id: 'AWL-2',
        status: 'FAILED',
        assigned_ca_email: 'op2@example.com',
        created_at: '2026-10-28T05:00:00.000Z',
        first_attempted_at: '2026-10-28T05:10:00.000Z',
      },
      {
        id: 'app-3',
        applywizz_id: 'AWL-3',
        status: 'READY_FOR_REVIEW',
        assigned_ca_email: 'op1@example.com',
        created_at: '2026-10-28T06:00:00.000Z',
      },
    ];

    const globalSummary = summarizeApplicationCohortRows(testRows);
    assert.deepEqual(globalSummary.counts, {
      total: 3,
      submitted: 2,
      applied: 1,
      failed: 1,
    });
    // Check candidate breakdown
    assert.equal(globalSummary.byCandidate.length, 3);
    // Check operator breakdown
    assert.equal(globalSummary.byOperator.length, 2);
    const op1 = globalSummary.byOperator.find((o) => o.email === 'op1@example.com');
    assert.deepEqual(op1, {
      email: 'op1@example.com',
      total: 2,
      submitted: 1,
      applied: 1,
      failed: 0,
    });
  });

  it('guarantees empty team scope returns zero applications and zero operators, never leaking global counts', async () => {
    // When a manager has no team operators, getApplicationStats MUST return 0 for all counts
    const parsedRange = parseDashboardStatsRange({ range: 'day' });
    assert.ok(!('error' in parsedRange));
    if ('error' in parsedRange) return;

    const stats = await getApplicationStats({
      range: parsedRange,
      scope: { managerEmail: 'manager-with-no-team@example.com' },
      includeBreakdown: true,
    });

    assert.equal(stats.counts.total, 0);
    assert.equal(stats.counts.submitted, 0);
    assert.equal(stats.counts.applied, 0);
    assert.equal(stats.counts.failed, 0);
    assert.deepEqual(stats.byCandidate, []);
    assert.deepEqual(stats.byOperator, []);
  });

  it('computes trend with valid day, week, month buckets', async () => {
    const parsedRange = parseDashboardStatsRange({
      range: 'custom',
      from: '2026-10-26',
      to: '2026-10-28',
    });
    assert.ok(!('error' in parsedRange));
    if ('error' in parsedRange) return;

    const trend = await getApplicationTrend({
      range: parsedRange,
      bucket: 'day',
    });

    assert.equal(trend.length, 3);
    assert.equal(trend[0].bucketStart, '2026-10-26');
    assert.equal(trend[1].bucketStart, '2026-10-27');
    assert.equal(trend[2].bucketStart, '2026-10-28');
  });
});
