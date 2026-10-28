import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { upsertProfile, getProfileByApplywizzId } from '../src/db/profiles.js';

describe('Merge-Safe Profile Upsert', () => {
  test('partial upsert preserves existing non-null demographic fields', async () => {
    const applywizzId = `AWL-MERGE-TEST-${Date.now()}`;

    // 1. Initial rich profile
    await upsertProfile({
      applywizz_id: applywizzId,
      client_name: 'Original Name',
      country: 'United States',
      country_code: '+1',
      phone: '3128682355',
      location: 'Chicago, Illinois, United States',
      linkedin_url: 'https://linkedin.com/in/original',
    });

    // 2. Partial update with only name and ID
    await upsertProfile({
      applywizz_id: applywizzId,
      client_name: 'Updated Name',
    });

    // 3. Verify demographic fields were not overwritten with NULL
    const updated = await getProfileByApplywizzId(applywizzId);
    assert.ok(updated, 'Profile should exist');
    assert.equal(updated.client_name, 'Updated Name');
    assert.equal(updated.country, 'United States');
    assert.equal(updated.country_code, '+1');
    assert.equal(updated.phone, '3128682355');
    assert.equal(updated.location, 'Chicago, Illinois, United States');
    assert.equal(updated.linkedin_url, 'https://linkedin.com/in/original');
  });
});
