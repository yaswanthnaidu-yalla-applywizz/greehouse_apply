import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDashboardStatsRange,
  DashboardCreatedAtPreset,
} from '../src/server/dashboardDateRange.js';
import {
  summarizeApplicationTrend,
  ApplicationCohortRow,
} from '../src/db/applicationStats.js';

describe('Dev trend chart and date selector contract', () => {
  it('supports all 5 date range selections: day, week, month, lifetime, custom', () => {
    const presets: DashboardCreatedAtPreset[] = ['day', 'week', 'month', 'lifetime'];
    for (const preset of presets) {
      const parsed = parseDashboardStatsRange({ range: preset });
      assert.ok(!('error' in parsed));
      if ('error' in parsed) continue;
      assert.equal(parsed.preset, preset);
      assert.ok(parsed.startIso);
      assert.ok(parsed.label);
    }

    const custom = parseDashboardStatsRange({
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-15',
    });
    assert.ok(!('error' in custom));
    if (!('error' in custom)) {
      assert.equal(custom.preset, 'custom');
      assert.equal(custom.fromDate, '2026-10-01');
      assert.equal(custom.toDate, '2026-10-15');
      assert.equal(custom.label, '2026-10-01 - 2026-10-15');
    }
  });

  it('calculates monthly and weekly trend points correctly', () => {
    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-w1',
        applywizz_id: 'AWL-1',
        status: 'APPLIED',
        assigned_ca_email: 'op@example.com',
        created_at: '2026-10-12T04:00:00.000Z', // Monday
        first_attempted_at: '2026-10-12T05:00:00.000Z',
      },
      {
        id: 'app-w2',
        applywizz_id: 'AWL-2',
        status: 'FAILED',
        assigned_ca_email: 'op@example.com',
        created_at: '2026-10-19T04:00:00.000Z', // Next Monday
        first_attempted_at: '2026-10-19T05:00:00.000Z',
      },
    ];

    const weeklyTrend = summarizeApplicationTrend(rows, {
      range: { fromDate: '2026-10-12', toDate: '2026-10-25' },
      bucket: 'week',
    });

    assert.equal(weeklyTrend.length, 2);
    assert.equal(weeklyTrend[0].bucketStart, '2026-10-12');
    assert.equal(weeklyTrend[0].successApplications, 1);
    assert.equal(weeklyTrend[0].failedApplications, 0);
    assert.equal(weeklyTrend[0].clients, 1);

    assert.equal(weeklyTrend[1].bucketStart, '2026-10-19');
    assert.equal(weeklyTrend[1].successApplications, 0);
    assert.equal(weeklyTrend[1].failedApplications, 1);
    assert.equal(weeklyTrend[1].clients, 0);
  });

  it('updates an older creation bucket when a retroactive status change occurs', () => {
    // Application originally created in week 1
    const originalRows: ApplicationCohortRow[] = [
      {
        id: 'app-old',
        applywizz_id: 'AWL-OLD',
        status: 'FAILED',
        assigned_ca_email: 'op@example.com',
        created_at: '2026-10-05T04:00:00.000Z',
        first_attempted_at: '2026-10-05T05:00:00.000Z',
      },
    ];
    const trendBefore = summarizeApplicationTrend(originalRows, {
      range: { fromDate: '2026-10-05', toDate: '2026-10-05' },
      bucket: 'day',
    });
    assert.equal(trendBefore[0].failedApplications, 1);
    assert.equal(trendBefore[0].successApplications, 0);

    // After retry / retroactive status change to APPLIED, the older bucket updates
    const updatedRows: ApplicationCohortRow[] = [
      {
        id: 'app-old',
        applywizz_id: 'AWL-OLD',
        status: 'APPLIED',
        assigned_ca_email: 'op@example.com',
        created_at: '2026-10-05T04:00:00.000Z',
        first_attempted_at: '2026-10-05T05:00:00.000Z',
      },
    ];
    const trendAfter = summarizeApplicationTrend(updatedRows, {
      range: { fromDate: '2026-10-05', toDate: '2026-10-05' },
      bucket: 'day',
    });
    assert.equal(trendAfter[0].failedApplications, 0);
    assert.equal(trendAfter[0].successApplications, 1);
    assert.equal(trendAfter[0].clients, 1);
  });

  it('includes records from current year 2026 when range is lifetime without 366-day cap truncation', () => {
    const lifetimeRange = parseDashboardStatsRange({ range: 'lifetime' });
    assert.ok(!('error' in lifetimeRange));
    if ('error' in lifetimeRange) return;

    const rows: ApplicationCohortRow[] = [
      {
        id: 'app-2026',
        applywizz_id: 'AWL-2026',
        status: 'APPLIED',
        assigned_ca_email: 'ca@example.com',
        created_at: '2026-10-28T04:00:00.000Z',
        first_attempted_at: '2026-10-28T04:10:00.000Z',
      },
    ];

    const trend = summarizeApplicationTrend(rows, {
      range: lifetimeRange,
      bucket: 'month',
    });

    const point2026 = trend.find((p) => p.bucketStart.startsWith('2026-10'));
    assert.ok(point2026, 'Trend must contain 2026 bucket under lifetime range');
    assert.equal(point2026.successApplications, 1);
    assert.equal(point2026.clients, 1);
  });
});
