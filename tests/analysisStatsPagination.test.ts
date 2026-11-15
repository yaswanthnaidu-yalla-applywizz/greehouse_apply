import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateAnalysisTimelineAndSummary } from '../src/server/analysisStats.js';

describe('Analysis Stats Aggregation', () => {
  it('correctly aggregates across all rows without capping at 1000', () => {
    const rows = [];
    for (let i = 0; i < 800; i++) {
      rows.push({
        id: `app_1_${i}`,
        applywizz_id: `AWL-${i % 100}`,
        status: 'APPLIED',
        created_at: '2026-11-10T04:00:00Z',
        ats: 'greenhouse',
      });
    }
    for (let i = 0; i < 700; i++) {
      rows.push({
        id: `app_2_${i}`,
        applywizz_id: `AWL-${i % 100}`,
        status: 'FAILED',
        created_at: '2026-11-11T04:00:00Z',
        ats: 'greenhouse',
        error_message: 'timeout waiting for element',
      });
    }

    const { summary, timeline, failures } = calculateAnalysisTimelineAndSummary(
      rows,
      '2026-11-10',
      '2026-11-11',
      'all'
    );

    assert.equal(summary.total, 1500);
    assert.equal(summary.applied, 800);
    assert.equal(summary.failed, 700);
    assert.equal(summary.clients, 100);
    assert.equal(summary.successRate, 53.3); // 800 / 1500
    assert.equal(summary.failureRate, 46.7); // 700 / 1500

    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].date, '2026-11-10');
    assert.equal(timeline[0].total, 800);
    assert.equal(timeline[0].applied, 800);
    assert.equal(timeline[0].failed, 0);

    assert.equal(timeline[1].date, '2026-11-11');
    assert.equal(timeline[1].total, 700);
    assert.equal(timeline[1].applied, 0);
    assert.equal(timeline[1].failed, 700);

    assert.ok(failures.length > 0);
  });
});
