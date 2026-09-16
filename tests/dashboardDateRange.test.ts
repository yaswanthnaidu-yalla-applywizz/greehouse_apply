import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDashboardCreatedAtRange,
  listIstDatesInclusive,
  parseDashboardCreatedAtRange,
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
});
