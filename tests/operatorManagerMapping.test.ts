import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAREER_ASSOCIATE_MANAGER_ID_TO_EMAIL,
  extractCareerAssociateManagerIdFromPayload,
  managerEmailForCareerAssociateManagerId,
} from '../src/services/operatorManagerMapping.js';

describe('operatorManagerMapping', () => {
  it('extracts careerassociatemanagerid from record', () => {
    const id = extractCareerAssociateManagerIdFromPayload({
      records: [{ applywizz_id: 'AWL-1', careerassociatemanagerid: '9DC9376E-FBC5-440B-932F-38DA10B89A70' }],
    });
    assert.equal(id, '9dc9376e-fbc5-440b-932f-38da10b89a70');
  });

  it('maps known manager ids to emails', () => {
    for (const [uuid, email] of Object.entries(CAREER_ASSOCIATE_MANAGER_ID_TO_EMAIL)) {
      assert.equal(managerEmailForCareerAssociateManagerId(uuid), email);
    }
    assert.equal(managerEmailForCareerAssociateManagerId('unknown-uuid'), null);
  });
});
