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

  it('parses nested CA-to-clients hierarchy from production CA mapping API', () => {
    const payload = {
      success: true,
      timestamp: '2026-10-26T07:39:46.589Z',
      total_cas: 2,
      total_assigned_clients: 3,
      data: [
        {
          ca_id: 'c0165dfa-02d7-46f8-b5f2-697ac65b3776',
          ca_name: 'Mohammad Hafeez',
          ca_email: 'mohammadhafeez@applywizz.com',
          client_count: 1,
          clients: [
            {
              applywizz_id: 'AWL-32313',
              client_email: 'sarathkumar.sugumar@applywizard.ai',
              full_name: 'SARATH KUMAR  SUGUMAR',
              assignment_type: 'permanent',
            },
          ],
        },
        {
          ca_id: 'c9b56bdb-628f-49e0-be0e-9c42ea58d50f',
          ca_name: 'Sharanya Peddi',
          ca_email: 'sharanyapeddi@applywizz.ai',
          client_count: 2,
          clients: [
            {
              applywizz_id: 'AWL-26974',
              client_email: 'aakanksharangdal1@gmail.com',
              full_name: 'Aakanksha Rukmanna Rangdal',
              assignment_type: 'permanent',
            },
            {
              applywizz_id: 'AWL-27855',
              client_email: 'aastrithav3@gmail.com',
              full_name: 'Aastritha V',
              assignment_type: 'permanent',
            },
          ],
        },
      ],
    };

    const parsed = parseCaMappingResponse(payload);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].applywizzId, 'AWL-32313');
    assert.equal(parsed[0].caEmail, 'mohammadhafeez@applywizz.com');
    assert.equal(parsed[0].clientName, 'SARATH KUMAR  SUGUMAR');

    assert.equal(parsed[1].applywizzId, 'AWL-26974');
    assert.equal(parsed[1].caEmail, 'sharanyapeddi@applywizz.ai');
    assert.equal(parsed[1].clientName, 'Aakanksha Rukmanna Rangdal');

    assert.equal(parsed[2].applywizzId, 'AWL-27855');
    assert.equal(parsed[2].caEmail, 'sharanyapeddi@applywizz.ai');
    assert.equal(parsed[2].clientName, 'Aastritha V');
  });
});
