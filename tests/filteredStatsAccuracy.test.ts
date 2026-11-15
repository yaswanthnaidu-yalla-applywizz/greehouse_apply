import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeBottomFunnelCounts } from '../src/server/filteredStats.js';

describe('Filtered Stats Accuracy', () => {
  it('does not classify FAILED or QUEUED applications as autoApplied', () => {
    const apps = [
      { id: '1', status: 'APPLIED' },
      { id: '2', status: 'EMAIL_PROOF_PENDING' },
      { id: '3', status: 'FAILED' },
      { id: '4', status: 'QUEUED' },
      { id: '5', status: 'READY_FOR_REVIEW' },
      { id: '6', status: 'FILTERED_OUT' },
      { id: '7', status: 'SKIPPED' },
      { id: '8', status: 'APPLYING' },
    ];

    const counts = categorizeBottomFunnelCounts(apps);
    assert.equal(counts.autoApplied, 2); // only APPLIED and EMAIL_PROOF_PENDING
    assert.equal(counts.failed, 1);
    assert.equal(counts.queued, 2); // QUEUED + APPLYING
    assert.equal(counts.readyForReview, 1);
    assert.equal(counts.filteredOut, 2); // FILTERED_OUT + SKIPPED
    assert.equal(counts.totalTasks, 8);
  });
});
