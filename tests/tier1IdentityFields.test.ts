import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

test('resolveTier1 matches What is your full legal name?', async () => {
  const field: ScannedField = {
    fieldId: 'legal_name_q',
    name: 'legal_name_q',
    type: 'text',
    label: 'What is your full legal name, as presented on your ID?',
    isRequired: true,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-NAME-1',
    client_name: 'Venkatesh Pallati',
    first_name: 'Venkatesh',
    last_name: 'Pallati',
  };
  const res = await resolveTier1('AWL-NAME-1', field, profile);
  assert.ok(res);
  assert.equal(res.value, 'Venkatesh Pallati');
});

test('resolveTier1 matches Legal Name (if different than above)', async () => {
  const field: ScannedField = {
    fieldId: 'legal_name_diff',
    name: 'legal_name_diff',
    type: 'text',
    label: 'Legal Name (if different than above)',
    isRequired: true,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-NAME-2',
    client_name: 'Manisha Medasani',
    first_name: 'Manisha',
    last_name: 'Medasani',
  };
  const res = await resolveTier1('AWL-NAME-2', field, profile);
  assert.ok(res);
  assert.equal(res.value, 'Manisha Medasani');
});

test('resolveTier1 matches Preferred Name', async () => {
  const field: ScannedField = {
    fieldId: 'pref_name',
    name: 'pref_name',
    type: 'text',
    label: 'Preferred Name',
    isRequired: false,
  };
  const profile: ProfileRow = {
    applywizz_id: 'AWL-NAME-3',
    client_name: 'Sai Kiran Akula',
    first_name: 'Sai Kiran',
    last_name: 'Akula',
  };
  const res = await resolveTier1('AWL-NAME-3', field, profile);
  assert.ok(res);
  assert.equal(res.value, 'Sai Kiran');
});
