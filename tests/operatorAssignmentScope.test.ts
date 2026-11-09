import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applicationAssignedCaAllowed } from '../src/server/managerTeamScope.js';

describe('operator application assignment scope', () => {
  it('allows only rows explicitly assigned to the signed-in operator', () => {
    assert.equal(applicationAssignedCaAllowed('operator@example.com', 'operator@example.com', 'operator', null), true);
    assert.equal(applicationAssignedCaAllowed('other@example.com', 'operator@example.com', 'operator', null), false);
    assert.equal(applicationAssignedCaAllowed(null, 'operator@example.com', 'operator', null), false);
  });

  it('does not change unrestricted staff access', () => {
    assert.equal(applicationAssignedCaAllowed(null, 'admin@example.com', 'admin', null), true);
    assert.equal(applicationAssignedCaAllowed('other@example.com', 'dev@example.com', 'dev', null), true);
  });
});
