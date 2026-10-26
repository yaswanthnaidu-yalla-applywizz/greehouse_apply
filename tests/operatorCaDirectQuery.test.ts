import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { distinctApplywizzIdsForOperatorEmails } from '../src/server/managerTeamScope.js';
import { mergeWorkHistoryForCaEmails } from '../src/server/workHistorySpan.js';

describe('operatorCaDirectQuery', () => {
  it('exports distinctApplywizzIdsForOperatorEmails function', () => {
    assert.equal(typeof distinctApplywizzIdsForOperatorEmails, 'function');
  });

  it('exports mergeWorkHistoryForCaEmails function', () => {
    assert.equal(typeof mergeWorkHistoryForCaEmails, 'function');
  });

  it('returns empty array when no operator emails provided', async () => {
    const ids = await distinctApplywizzIdsForOperatorEmails([]);
    assert.deepEqual(ids, []);
  });
});
