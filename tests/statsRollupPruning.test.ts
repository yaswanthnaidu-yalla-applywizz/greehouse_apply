import test from 'node:test';
import assert from 'node:assert/strict';
import { RETAINED_APPLICATION_STATUSES, buildRetainedStatusFilter } from '../src/db/statsRollup.js';

test('statsRollupPruning constants and filter formatting', () => {
  assert.deepEqual(RETAINED_APPLICATION_STATUSES, ['APPLIED', 'EMAIL_PROOF_PENDING']);
  assert.equal(buildRetainedStatusFilter(), '("APPLIED","EMAIL_PROOF_PENDING")');
});
