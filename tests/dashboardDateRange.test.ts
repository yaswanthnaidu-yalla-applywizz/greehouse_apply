import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDashboardCreatedAtRange,
  listIstDatesInclusive,
  parseDashboardCreatedAtRange,
  parseDashboardStatsRange,
} from '../src/server/dashboardDateRange.js';

describe('dashboardDateRange', () => {
  it('defaults to rolling two-day window with Today & Yesterday label', () => {
    const range = defaultDashboardCreatedAtRange();
    assert.equal(range.preset, 'default');
    assert.equal(range.label, 'Today & Yesterday');
    assert.equal(range.endIso, null);
    const ageMs = Date.now() - new Date(range.startIso).getTime();
    assert.ok(ageMs >= 2 * 24 * 60 * 60 * 1000 - 5000);
    assert.ok(ageMs <= 2 * 24 * 60 * 60 * 1000 + 5000);
  });

  it('parses custom from/to in IST day bounds', () => {
    const parsed = parseDashboardCreatedAtRange({ from: '2026-09-10', to: '2026-09-12' });
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.preset, 'custom');
    assert.equal(parsed.fromDate, '2026-09-10');
    assert.equal(parsed.toDate, '2026-09-12');
    assert.ok(parsed.endIso);
  });

  it('rejects inverted custom range', () => {
    const parsed = parseDashboardCreatedAtRange({ from: '2026-09-12', to: '2026-09-10' });
    assert.ok('error' in parsed);
  });

  it('lists inclusive IST dates', () => {
    assert.deepEqual(listIstDatesInclusive('2026-09-10', '2026-09-12'), [
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
    ]);
  });

  it('parses single date in parseDashboardStatsRange', () => {
    const parsed = parseDashboardStatsRange({ date: '2026-10-14' });
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.preset, 'custom');
    assert.equal(parsed.fromDate, '2026-10-14');
    assert.equal(parsed.toDate, '2026-10-14');
    assert.equal(parsed.label, '2026-10-14 - 2026-10-14');
  });

  it('parses lifetime range in parseDashboardStatsRange', () => {
    const parsed = parseDashboardStatsRange({ range: 'lifetime' });
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.preset, 'lifetime');
    assert.equal(parsed.fromDate, '2000-01-01');
    assert.equal(parsed.label, 'Lifetime');
  });

  it('accepts today alias for day in parseDashboardStatsRange', () => {
    const parsed = parseDashboardStatsRange({ range: 'today' });
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.preset, 'day');
    assert.equal(parsed.label, 'Today');
  });

  it('includes Monday 00:10 IST in Monday week bounds even though UTC is Sunday', () => {
    // 2026-10-26 00:10:00 IST is 2026-10-25 18:40:00 UTC
    const mondayIstInstant = new Date('2026-10-25T18:40:00.000Z');
    const parsed = parseDashboardStatsRange({ range: 'week' }, mondayIstInstant);
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.preset, 'week');
    assert.equal(parsed.fromDate, '2026-10-26');
    assert.equal(parsed.toDate, '2026-10-26');
    // Start bound must be Monday 00:00:00 IST = 2026-10-25T18:30:00.000Z
    assert.equal(parsed.startIso, '2026-10-25T18:30:00.000Z');
    // Monday 00:10 IST must be >= startIso and < endIso
    const appCreatedUtc = mondayIstInstant.toISOString();
    assert.ok(appCreatedUtc >= parsed.startIso);
    assert.ok(parsed.endIso && appCreatedUtc < parsed.endIso);
  });

  it('handles week calculation across month and year rollover correctly in IST', () => {
    // Friday 2027-01-01 10:00:00 IST (UTC: 2027-01-01T04:30:00.000Z)
    // Monday of that week was 2026-12-28
    const newYearInstant = new Date('2027-01-01T04:30:00.000Z');
    const parsed = parseDashboardStatsRange({ range: 'week' }, newYearInstant);
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.preset, 'week');
    assert.equal(parsed.fromDate, '2026-12-28');
    assert.equal(parsed.toDate, '2027-01-01');
    assert.equal(parsed.startIso, '2026-12-27T18:30:00.000Z');
    assert.equal(parsed.endIso, '2027-01-01T18:30:00.000Z');
  });

  it('supports custom single day via query.from == query.to or query.date', () => {
    const parsedFromTo = parseDashboardStatsRange({ range: 'custom', from: '2026-10-05', to: '2026-10-05' });
    assert.ok(!('error' in parsedFromTo));
    if ('error' in parsedFromTo) return;
    assert.equal(parsedFromTo.preset, 'custom');
    assert.equal(parsedFromTo.fromDate, '2026-10-05');
    assert.equal(parsedFromTo.toDate, '2026-10-05');
    assert.equal(parsedFromTo.label, '2026-10-05 - 2026-10-05');
    assert.equal(parsedFromTo.startIso, '2026-10-04T18:30:00.000Z');
    assert.equal(parsedFromTo.endIso, '2026-10-05T18:30:00.000Z');
  });

  it('rejects inverted custom date range in parseDashboardStatsRange', () => {
    const parsed = parseDashboardStatsRange({ range: 'custom', from: '2026-10-20', to: '2026-10-10' });
    assert.ok('error' in parsed);
  });

  it('calculates current week ending today (not Sunday) for mid-week query', () => {
    // Wednesday 2026-10-28 14:00:00 IST (UTC: 2026-10-28T08:30:00.000Z)
    const midWeekInstant = new Date('2026-10-28T08:30:00.000Z');
    const parsed = parseDashboardStatsRange({ range: 'week' }, midWeekInstant);
    assert.ok(!('error' in parsed));
    if ('error' in parsed) return;
    assert.equal(parsed.fromDate, '2026-10-26');
    assert.equal(parsed.toDate, '2026-10-28');
    assert.equal(parsed.startIso, '2026-10-25T18:30:00.000Z');
    assert.equal(parsed.endIso, '2026-10-28T18:30:00.000Z');
  });
});
