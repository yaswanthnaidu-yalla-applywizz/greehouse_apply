import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCandidateVolumeRows,
  candidateVolumeCache,
} from '../src/server/candidateVolume.js';

describe('Candidate Volume Service', () => {
  it('correctly aggregates applied and email proof pending counts per candidate', () => {
    const rawRows = [
      { id: '1', applywizz_id: 'AWL-001', status: 'APPLIED', created_at: '2026-11-15T04:00:00Z' },
      { id: '2', applywizz_id: 'AWL-001', status: 'EMAIL_PROOF_PENDING', created_at: '2026-11-15T04:10:00Z' },
      { id: '3', applywizz_id: 'AWL-001', status: 'APPLIED', created_at: '2026-11-15T04:20:00Z' },
      { id: '4', applywizz_id: 'AWL-002', status: 'APPLIED', created_at: '2026-11-15T04:05:00Z' },
      { id: '5', applywizz_id: 'AWL-002', status: 'EMAIL_PROOF_PENDING', created_at: '2026-11-15T04:15:00Z' },
      { id: '6', applywizz_id: 'AWL-003', status: 'EMAIL_PROOF_PENDING', created_at: '2026-11-15T04:25:00Z' },
    ];

    const profilesMap = new Map([
      ['AWL-001', { name: 'Alice Smith', email: 'alice@example.com' }],
      ['AWL-002', { name: 'Bob Jones', email: 'bob@example.com' }],
      ['AWL-003', { name: 'Charlie Brown', email: 'charlie@example.com' }],
    ]);

    const result = aggregateCandidateVolumeRows(rawRows, profilesMap);

    assert.equal(result.totals.candidateCount, 3);
    assert.equal(result.totals.applied, 3);
    assert.equal(result.totals.emailProofPending, 3);
    assert.equal(result.totals.totalSubmitted, 6);

    assert.equal(result.candidates.length, 3);

    // Sorted by totalSubmitted desc
    assert.equal(result.candidates[0].applywizzId, 'AWL-001');
    assert.equal(result.candidates[0].candidateName, 'Alice Smith');
    assert.equal(result.candidates[0].appliedCount, 2);
    assert.equal(result.candidates[0].emailProofPendingCount, 1);
    assert.equal(result.candidates[0].totalSubmittedCount, 3);

    assert.equal(result.candidates[1].applywizzId, 'AWL-002');
    assert.equal(result.candidates[1].appliedCount, 1);
    assert.equal(result.candidates[1].emailProofPendingCount, 1);
    assert.equal(result.candidates[1].totalSubmittedCount, 2);

    assert.equal(result.candidates[2].applywizzId, 'AWL-003');
    assert.equal(result.candidates[2].appliedCount, 0);
    assert.equal(result.candidates[2].emailProofPendingCount, 1);
    assert.equal(result.candidates[2].totalSubmittedCount, 1);
  });

  it('manages cache set, get, and invalidate correctly', () => {
    candidateVolumeCache.clear();
    const testPayload = { candidates: [], totals: { candidateCount: 0, applied: 0, emailProofPending: 0, totalSubmitted: 0 }, dateRange: { from: '2026-11-15', to: '2026-11-15', label: 'Today' } };
    
    candidateVolumeCache.set('test_key', testPayload as any, 1000);
    assert.deepEqual(candidateVolumeCache.get('test_key'), testPayload);

    candidateVolumeCache.clear();
    assert.equal(candidateVolumeCache.get('test_key'), null);
  });
});
