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
  assert.equal(res.policyId, 'policy_mandatory_agreements');
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
