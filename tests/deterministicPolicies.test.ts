import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeterministicPolicy } from '../src/resolver/deterministicPolicies.js';
import { mapSalaryRangeToOption, mapWorkplaceLocationToOption } from '../src/utils/choiceOptions.js';
import { classifyFieldIntent } from '../src/resolver/fieldIntent.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

test('SMS consent selects unambiguous No choice', () => {
  const field: ScannedField = {
    fieldId: 'sms_consent',
    name: 'sms_consent',
    type: 'radio',
    label: 'Phone Number',
    options: ['Yes, send me text messages', 'No, do not send me text messages'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);
  const res = resolveDeterministicPolicy(field, intent, null, {});
  assert.ok(res);
  assert.equal(res.value, 'No, do not send me text messages');
  assert.equal(res.policyId, 'policy_sms_consent');
});

test('Phone input is ineligible for SMS consent policy', () => {
  const field: ScannedField = {
    fieldId: 'phone',
    name: 'phone',
    type: 'text',
    label: 'Phone Number',
    isRequired: true,
    metadata: { inputType: 'tel' },
  };
  const intent = classifyFieldIntent(field);
  const res = resolveDeterministicPolicy(field, intent, null, {});
  assert.equal(res, null, 'Telephone input must not resolve from SMS consent policy');
});

test('Mandatory agreements select affirmative option', () => {
  const field: ScannedField = {
    fieldId: 'ai_policy',
    name: 'ai_policy',
    type: 'select',
    label: 'I acknowledge the AI usage policy and agree to terms',
    options: ['I Agree', 'I Disagree'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);
  const res = resolveDeterministicPolicy(field, intent, null, {});
  assert.ok(res);
  assert.equal(res.value, 'I Agree');
  assert.ok(
    res.policyId === 'policy_corporate_rules' || res.policyId === 'policy_mandatory_agreements',
    `Expected policy_corporate_rules or policy_mandatory_agreements, got ${res.policyId}`
  );
});

test('Posting location maps only to one matching option', () => {
  const field: ScannedField = {
    fieldId: 'workplace',
    name: 'workplace',
    type: 'select',
    label: 'Preferred office location',
    options: ['New York, NY', 'San Francisco, CA', 'London, UK'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);

  // Exact match
  const res = resolveDeterministicPolicy(field, intent, null, { jobPostingLocation: 'New York City' });
  assert.ok(res);
  assert.equal(res.value, 'New York, NY');

  // Ambiguous match returns null
  const ambiguous = mapWorkplaceLocationToOption('USA', ['New York, NY', 'San Francisco, CA']);
  assert.equal(ambiguous, null);
});

test('Absent posting location selects affirmative relocation option without candidate evidence', () => {
  const field: ScannedField = {
    fieldId: 'relocate',
    name: 'relocate',
    type: 'select',
    label: 'Are you willing to relocate for this role?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);
  const res = resolveDeterministicPolicy(field, intent, null, {});
  assert.ok(res);
  assert.equal(res.value, 'Yes');
  assert.equal(res.policyId, 'policy_relocation_affirmative');
});

test('Relocation policy respects an explicit candidate preference and defaults affirmative only when absent', () => {
  const field: ScannedField = {
    fieldId: 'relocate',
    name: 'relocate',
    type: 'select',
    label: 'Are you willing to relocate?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);
  const resolve = (willingToRelocate?: boolean) => resolveDeterministicPolicy(
    field,
    intent,
    willingToRelocate === undefined
      ? { applywizz_id: 'AWL-TEST', client_name: 'Test Candidate' } as ProfileRow
      : {
          applywizz_id: 'AWL-TEST',
          client_name: 'Test Candidate',
          raw_api_payload: { additional_information: { willing_to_relocate: willingToRelocate } },
        } as ProfileRow
  );

  const declined = resolve(false);
  assert.equal(declined?.value, 'No');
  assert.equal(declined?.policyId, 'policy_relocation_candidate_preference');
  assert.equal(declined?.provenance.evidenceKey, 'willing_to_relocate');

  assert.equal(resolve(true)?.value, 'Yes');
  assert.equal(resolve(undefined)?.value, 'Yes');

  const preferenceField = { ...field, label: 'Relocation preference' };
  const preferenceIntent = classifyFieldIntent(preferenceField);
  const candidatePreference = resolveDeterministicPolicy(
    preferenceField,
    preferenceIntent,
    {
      applywizz_id: 'AWL-TEST',
      client_name: 'Test Candidate',
      raw_api_payload: { additional_information: { willing_to_relocate: false } },
    } as ProfileRow
  );
  assert.equal(candidatePreference?.value, 'No');
  assert.equal(candidatePreference?.policyId, 'policy_relocation_candidate_preference');
});

test('Explicit relocation preference takes precedence over posting location only for relocation questions', () => {
  const relocationField: ScannedField = {
    fieldId: 'relocate',
    name: 'relocate',
    type: 'select',
    label: 'Are you willing to relocate?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(relocationField);
  const profile = (willingToRelocate: boolean): ProfileRow => ({
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    raw_api_payload: { additional_information: { willing_to_relocate: willingToRelocate } },
  });

  assert.equal(
    resolveDeterministicPolicy(relocationField, intent, profile(false), { jobPostingLocation: 'Boston, MA' })?.value,
    'No'
  );
  assert.equal(
    resolveDeterministicPolicy(relocationField, intent, profile(true), { jobPostingLocation: 'Boston, MA' })?.value,
    'Yes'
  );

  const openQuestion = { ...relocationField, label: 'Are you open to relocation?' };
  assert.equal(
    resolveDeterministicPolicy(openQuestion, classifyFieldIntent(openQuestion), profile(false), { jobPostingLocation: 'Boston, MA' })?.value,
    'No',
    'Open-to-relocation wording expresses candidate willingness'
  );

  const wouldQuestion = { ...relocationField, label: 'Would you relocate for this role?' };
  assert.equal(
    resolveDeterministicPolicy(wouldQuestion, classifyFieldIntent(wouldQuestion), profile(false), { jobPostingLocation: 'Boston, MA' })?.value,
    'No',
    'Direct willingness wording must respect the candidate profile'
  );

  const noNoOption = { ...relocationField, options: ['Boston, MA', 'New York, NY'] };
  assert.equal(
    resolveDeterministicPolicy(noNoOption, classifyFieldIntent(noNoOption), profile(false), { jobPostingLocation: 'Boston, MA' }),
    null,
    'An explicit refusal must not be replaced with a posting-location match when no No option exists'
  );

  assert.equal(
    resolveDeterministicPolicy(noNoOption, classifyFieldIntent(noNoOption), profile(true), { jobPostingLocation: 'Boston, MA' }),
    null,
    'A location option must not stand in for an affirmative willingness answer'
  );

  const unknownProfile = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    raw_api_payload: { additional_information: { willing_to_relocate: 'unknown' } },
  } as ProfileRow;
  assert.equal(
    resolveDeterministicPolicy(noNoOption, classifyFieldIntent(noNoOption), unknownProfile, { jobPostingLocation: 'Boston, MA' }),
    null,
    'Unknown willingness must not fall through to posting-location mapping'
  );

  const officeField: ScannedField = {
    fieldId: 'office',
    name: 'office',
    type: 'select',
    label: 'Preferred office location',
    options: ['Boston, MA', 'New York, NY'],
    isRequired: true,
  };
  assert.equal(
    resolveDeterministicPolicy(officeField, classifyFieldIntent(officeField), profile(false), { jobPostingLocation: 'Boston, MA' })?.value,
    'Boston, MA',
    'Relocation preference must not override office-location matching'
  );

  for (const label of [
    'Does the company provide relocation assistance?',
    'Have you relocated before?',
  ]) {
    const unrelatedQuestion = { ...relocationField, label };
    const result = resolveDeterministicPolicy(
      unrelatedQuestion,
      classifyFieldIntent(unrelatedQuestion),
      profile(false),
      {}
    );
    assert.equal(result, null, `${label} must not receive a relocation willingness fallback`);

    assert.equal(
      resolveDeterministicPolicy(unrelatedQuestion, classifyFieldIntent(unrelatedQuestion), null, {}),
      null,
      `${label} must stay unresolved when the candidate preference is missing`
    );
  }

  const misleadingIdentifiers: ScannedField = {
    fieldId: 'relocation_preference',
    name: 'relocation_preference',
    type: 'select',
    label: 'Have you relocated before?',
    options: ['Boston, MA', 'New York, NY'],
    isRequired: true,
  };
  assert.equal(classifyFieldIntent(misleadingIdentifiers).family, 'workplace_preference');
  assert.equal(
    resolveDeterministicPolicy(
      misleadingIdentifiers,
      classifyFieldIntent(misleadingIdentifiers),
      profile(false),
      { jobPostingLocation: 'Boston, MA' }
    ),
    null,
    'The label, rather than relocation-related identifiers, must determine whether willingness applies'
  );
});

test('Nonboolean relocation preference remains unknown and keeps the affirmative fallback', () => {
  const field: ScannedField = {
    fieldId: 'relocate',
    name: 'relocate',
    type: 'select',
    label: 'Are you willing to relocate?',
    options: ['Yes', 'No'],
    isRequired: true,
  };
  const profile = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    raw_api_payload: { additional_information: { willing_to_relocate: 'false' } },
  } as ProfileRow;
  const res = resolveDeterministicPolicy(field, classifyFieldIntent(field), profile, {});
  assert.equal(res?.value, 'Yes');
  assert.equal(res?.policyId, 'policy_relocation_affirmative');
});

test('Missing or ambiguous relocation options return null', () => {
  const field: ScannedField = {
    fieldId: 'relocate',
    name: 'relocate',
    type: 'select',
    label: 'Are you willing to relocate?',
    options: ['Only within state', 'Only internationally'],
    isRequired: true,
  };
  const intent = classifyFieldIntent(field);
  const res = resolveDeterministicPolicy(field, intent, null, {});
  assert.equal(res, null, 'Ambiguous relocation options without clear Yes return null');
});

test('Salary range mapping returns closest band and ties return null', () => {
  const options = ['$80,000 - $100,000', '$100,000 - $120,000', '$120,000 - $140,000'];

  // Clear single closest band
  const match = mapSalaryRangeToOption('$115,000', options);
  assert.equal(match, '$100,000 - $120,000');

  // Exact midpoint tie between bands returns null
  const tied = mapSalaryRangeToOption('$100,000', ['$80,000 - $100,000', '$100,000 - $120,000']);
  assert.equal(tied, null, 'Exact tie between bands must return null');
});
