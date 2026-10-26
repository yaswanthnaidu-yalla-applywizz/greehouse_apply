import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { syncCaCandidateAssignments, parseCaMappingResponse } from '../src/services/caAssignmentSync.js';

describe('caAssignmentSync', () => {
  it('exports syncCaCandidateAssignments function', () => {
    assert.equal(typeof syncCaCandidateAssignments, 'function');
  });

  it('handles missing CA_MAPPING_API_URL gracefully without throwing', async () => {
    const result = await syncCaCandidateAssignments();
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.syncedCount, 'number');
  });

  it('parses array of mapping records correctly', () => {
    const payload = [
      { applywizz_id: 'AWL-101', ca_email: 'ca1@applywizz.ai' },
      { applywizzId: 'AWL-102', caEmail: 'ca2@applywizz.ai' },
      { applywizz_id: 'AWL-103', client_email: 'ca3@applywizz.ai' },
    ];
    const parsed = parseCaMappingResponse(payload);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].applywizzId, 'AWL-101');
    assert.equal(parsed[0].caEmail, 'ca1@applywizz.ai');
    assert.equal(parsed[1].applywizzId, 'AWL-102');
    assert.equal(parsed[1].caEmail, 'ca2@applywizz.ai');
  });

  it('parses nested records array correctly', () => {
    const payload = {
      records: [
        { applywizz_id: 'AWL-201', ca_email: 'ca4@applywizz.ai' },
      ],
    };
    const parsed = parseCaMappingResponse(payload);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].applywizzId, 'AWL-201');
    assert.equal(parsed[0].caEmail, 'ca4@applywizz.ai');
  });
});
