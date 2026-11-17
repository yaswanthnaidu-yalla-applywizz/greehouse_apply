import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import { inferYesNoFromProfile } from '../src/resolver/llmSynthesizer.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

test('Sponsorship question containing work authorization resolves to No when requires_sponsorship is false', async () => {
  const field: ScannedField = {
    fieldId: 'sponsorship_q',
    name: 'sponsorship_q',
    type: 'select',
    label: 'Will you now or at any time in the future require sponsorship for employment-based immigration status or work authorization?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-1',
    client_name: 'Test Candidate',
    requires_sponsorship: false,
    work_authorization: 'F1',
  };

  const res = await resolveTier1('AWL-TEST-1', field, profile);
  assert.ok(res, 'Field should resolve');
  assert.equal(res.value, 'No', 'Must answer No when requires_sponsorship is false');

  const synthRes = inferYesNoFromProfile(field, {
    applywizzId: 'AWL-TEST-1',
    clientName: 'Test Candidate',
    requiresSponsorship: false,
    workAuthorization: 'F1',
  } as any);
  assert.equal(synthRes, 'No', 'Synthesizer inferYesNoFromProfile must answer No');
});

test('Spousal sponsorship dependency question resolves to No', async () => {
  const field: ScannedField = {
    fieldId: 'spouse_q',
    name: 'spouse_q',
    type: 'select',
    label: 'Is your current work authorization dependent upon your spouse’s immigration related sponsorship status?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-2',
    client_name: 'Test Candidate',
    requires_sponsorship: false,
    work_authorization: 'F1',
  };

  const res = await resolveTier1('AWL-TEST-2', field, profile);
  assert.ok(res, 'Field should resolve');
  assert.equal(res.value, 'No', 'Must answer No for spousal sponsorship dependency');
});

test('General work authorization without sponsorship inquiry still resolves to Yes', async () => {
  const field: ScannedField = {
    fieldId: 'auth_q',
    name: 'auth_q',
    type: 'select',
    label: 'Are you legally authorized to work in the United States?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-3',
    client_name: 'Test Candidate',
    requires_sponsorship: false,
    work_authorization: 'F1',
  };

  const res = await resolveTier1('AWL-TEST-3', field, profile);
  assert.ok(res, 'Field should resolve');
  assert.equal(res.value, 'Yes', 'Must answer Yes for general work authorization');
});
