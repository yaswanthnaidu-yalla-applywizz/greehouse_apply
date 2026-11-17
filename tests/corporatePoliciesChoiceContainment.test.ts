import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCorporatePolicy, enforceCorporatePolicy } from '../src/resolver/corporatePolicies.js';
import type { ScannedField, ResolvedField } from '../src/types/index.js';

test('matchCorporatePolicy does not return Yes when Yes is not an option for commute questions', () => {
  const field: ScannedField = {
    fieldId: 'commute_hubs',
    name: 'commute_hubs',
    type: 'select',
    label: 'Are you able to work in-person at least 3 days a week from one of our office hubs?',
    options: [
      'Yes, in the San Francisco office',
      'Yes, in the Toronto office',
      "No, I'm not able to work in-person at least 3 days a week from an office",
    ],
    isRequired: true,
  };
  const val = matchCorporatePolicy(field);
  assert.ok(val, 'Should return a valid option');
  assert.notEqual(val, 'Yes', 'Must not return bare Yes string');
  assert.ok(field.options?.includes(val), 'Must return an exact option from field.options');
  assert.equal(val, 'Yes, in the San Francisco office');
});

test('matchCorporatePolicy does not return Yes when Yes is not an option for travel questions', () => {
  const field: ScannedField = {
    fieldId: 'travel_q',
    name: 'travel_q',
    type: 'select',
    label: 'Are you open to travel?',
    options: ['State-wide', 'Nationwide', 'Both', 'None'],
    isRequired: true,
  };
  const val = matchCorporatePolicy(field);
  assert.ok(val);
  assert.notEqual(val, 'Yes', 'Must not return bare Yes string');
  assert.ok(field.options?.includes(val), 'Must be in options');
  assert.equal(val, 'Both');
});

test('enforceCorporatePolicy does not clamp choice field to a value outside field.options', () => {
  const field: ScannedField = {
    fieldId: 'travel_q',
    name: 'travel_q',
    type: 'select',
    label: 'Are you open to travel?',
    options: ['State-wide', 'Nationwide', 'Both', 'None'],
    isRequired: true,
  };
  const resolved: ResolvedField = {
    fieldId: 'travel_q',
    name: 'travel_q',
    type: 'select',
    label: 'Are you open to travel?',
    value: 'Both',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.9,
    isRequired: true,
    options: ['State-wide', 'Nationwide', 'Both', 'None'],
  };
  const clamped = enforceCorporatePolicy(field, resolved);
  assert.equal(clamped.value, 'Both');
});
