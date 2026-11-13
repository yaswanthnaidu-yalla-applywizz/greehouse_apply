import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import type { ProfileRow } from '../src/db/profiles.js';
import type { ScannedField } from '../src/types/index.js';

test('resolveTier1 maps candidate education degree to closest form option', async () => {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-1',
    client_name: 'Test Client',
    education: [
      {
        institution: 'University of Texas at Dallas',
        degree: "Master's Degree",
        fieldOfStudy: 'Computer Science',
        graduationYear: '2023',
      },
    ],
  };

  const degreeField: ScannedField = {
    fieldId: 'degree--0',
    name: 'degree--0',
    type: 'select',
    label: 'Degree',
    isRequired: true,
    options: ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"],
  };

  const resolved = await resolveTier1('AWL-TEST-1', degreeField, profile);
  assert.ok(resolved);
  assert.equal(resolved.value, "Master's Degree");
});

test('resolveTier1 maps B.Tech candidate degree to Bachelor\'s Degree option', async () => {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-2',
    client_name: 'Test Client',
    education: [
      {
        institution: 'IIT Madras',
        degree: 'Bachelor of Technology',
        fieldOfStudy: 'Computer Science',
        graduationYear: '2020',
      },
    ],
  };

  const degreeField: ScannedField = {
    fieldId: 'degree--0',
    name: 'degree--0',
    type: 'select',
    label: 'Degree',
    isRequired: true,
    options: ["Bachelor's Degree", "Master's Degree", "Doctorate"],
  };

  const resolved = await resolveTier1('AWL-TEST-2', degreeField, profile);
  assert.ok(resolved);
  assert.equal(resolved.value, "Bachelor's Degree");
});

test('resolveTier1 returns null when candidate has no degree in profile (zero-hallucination fall-through)', async () => {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-3',
    client_name: 'Test Client',
    education: [],
  };

  const degreeField: ScannedField = {
    fieldId: 'degree--0',
    name: 'degree--0',
    type: 'select',
    label: 'Degree',
    isRequired: true,
    options: ["Bachelor's Degree", "Master's Degree", "Doctorate"],
  };

  const resolved = await resolveTier1('AWL-TEST-3', degreeField, profile);
  assert.equal(resolved, null, 'Must be null so it falls through tiers rather than guessing');
});

test('resolveTier1 maps candidate institution to school field', async () => {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-4',
    client_name: 'Test Client',
    education: [
      {
        institution: 'Georgia Institute of Technology',
        degree: "Master's Degree",
        fieldOfStudy: 'Computer Science',
        graduationYear: '2022',
      },
    ],
  };

  const schoolField: ScannedField = {
    fieldId: 'school--0',
    name: 'school--0',
    type: 'text',
    label: 'School',
    isRequired: true,
  };

  const resolved = await resolveTier1('AWL-TEST-4', schoolField, profile);
  assert.ok(resolved);
  assert.equal(resolved.value, 'Georgia Institute of Technology');
});

test('resolveTier1 maps candidate demographics to closest available options', async () => {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-5',
    client_name: 'Test Client',
    raw_api_payload: {
      demographics: {
        gender: 'Male',
        raceEthnicity: 'Asian',
        veteranStatus: 'I am not a protected veteran',
        disabilityStatus: 'No, I do not have a disability',
      },
    },
  };

  const raceField: ScannedField = {
    fieldId: 'race',
    name: 'race',
    type: 'select',
    label: 'Please identify your race',
    options: ['White', 'Black or African American', 'Asian (not Hispanic or Latino)', 'Two or more races'],
  };

  const resolvedRace = await resolveTier1('AWL-TEST-5', raceField, profile);
  assert.ok(resolvedRace);
  assert.equal(resolvedRace.value, 'Asian (not Hispanic or Latino)');

  const veteranField: ScannedField = {
    fieldId: 'veteran_status',
    name: 'veteran_status',
    type: 'select',
    label: 'Veteran Status',
    options: ['I am a protected veteran', 'I am not a protected veteran', 'Decline to self-identify'],
  };

  const resolvedVeteran = await resolveTier1('AWL-TEST-5', veteranField, profile);
  assert.ok(resolvedVeteran);
  assert.equal(resolvedVeteran.value, 'I am not a protected veteran');
});

test('resolveTier1 returns null when candidate has no demographic data (does not auto-decline or guess)', async () => {
  const profile: ProfileRow = {
    applywizz_id: 'AWL-TEST-6',
    client_name: 'Test Client',
    raw_api_payload: {},
  };

  const veteranField: ScannedField = {
    fieldId: 'veteran_status',
    name: 'veteran_status',
    type: 'select',
    label: 'Veteran Status',
    options: ['I am a protected veteran', 'I am not a protected veteran', 'Decline to self-identify'],
  };

  const resolved = await resolveTier1('AWL-TEST-6', veteranField, profile);
  assert.equal(resolved, null, 'Must return null so it falls through rather than auto-declining');
});
