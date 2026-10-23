import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailProofWorkerPool } from '../src/submitter/emailProofWorkerPool.js';

describe('EmailProofWorkerPool', () => {
  it('creates worker pool with maximum 3 concurrency lanes', () => {
    const pool = new EmailProofWorkerPool({ concurrency: 3 });
    const snapshot = pool.getSnapshot();
    assert.equal(snapshot.maxWorkers, 3);
    assert.equal(snapshot.activeWorkers, 0);
    assert.equal(snapshot.isBatchActive, false);
  });

  it('caps concurrency at 3 even if higher is requested', () => {
    const pool = new EmailProofWorkerPool({ concurrency: 10 });
    const snapshot = pool.getSnapshot();
    assert.equal(snapshot.maxWorkers, 3);
  });
});
