import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeApplicationFromRealtimeRow,
  shouldAcceptApplicationRealtimeRow,
} from '../src/dashboard/applicationRealtimeMerge.js';

describe('application realtime merge ordering', () => {
  const previous = {
    id: 'app-1',
    applywizz_id: 'AWL-1',
    job_url: 'https://jobs.example/1',
    status: 'APPLIED',
    updated_at: '2026-10-30T05:00:00.000Z',
  };

  it('rejects an older APPLYING row over a newer APPLIED row', () => {
    const older = { ...previous, status: 'APPLYING', updated_at: '2026-10-30T04:59:00.000Z' };
    assert.equal(shouldAcceptApplicationRealtimeRow(previous, older), false);
    assert.equal(mergeApplicationFromRealtimeRow(previous, older, 'AWL-1')?.status, 'APPLIED');
  });

  it('accepts a newer APPLYING row for a legitimate retry', () => {
    const newer = { ...previous, status: 'APPLYING', updated_at: '2026-10-30T05:01:00.000Z' };
    assert.equal(shouldAcceptApplicationRealtimeRow(previous, newer), true);
    assert.equal(mergeApplicationFromRealtimeRow(previous, newer, 'AWL-1')?.status, 'APPLYING');
  });

  it('keeps the current row when conflicting statuses have equal timestamps', () => {
    const equal = { ...previous, status: 'APPLYING' };
    assert.equal(shouldAcceptApplicationRealtimeRow(previous, equal), false);
    assert.equal(mergeApplicationFromRealtimeRow(previous, equal, 'AWL-1')?.status, 'APPLIED');
  });

  it('keeps the existing permissive behavior when timestamps are unavailable', () => {
    const untimed = { ...previous, status: 'APPLYING', updated_at: undefined };
    assert.equal(shouldAcceptApplicationRealtimeRow(previous, untimed), true);
    assert.equal(mergeApplicationFromRealtimeRow(previous, untimed, 'AWL-1')?.status, 'APPLYING');
  });
});
