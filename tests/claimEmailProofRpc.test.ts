import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimNextEmailProofApplication } from '../src/db/applications/queue.js';

describe('claimNextEmailProofApplication', () => {
  it('exports claimNextEmailProofApplication function', () => {
    assert.equal(typeof claimNextEmailProofApplication, 'function');
  });
});
