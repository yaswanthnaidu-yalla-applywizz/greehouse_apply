import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { distinctApplywizzIdsForOperatorEmails } from '../src/server/managerTeamScope.js';

describe('operatorCaDirectQuery', () => {
  it('exports distinctApplywizzIdsForOperatorEmails function', () => {
    assert.equal(typeof distinctApplywizzIdsForOperatorEmails, 'function');
  });

  it('returns empty array when no operator emails provided', async () => {
    const ids = await distinctApplywizzIdsForOperatorEmails([]);
    assert.deepEqual(ids, []);
  });
});
