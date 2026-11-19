import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import type { ScannedField, ResolvedField } from '../src/types/index.js';

test('alignResolvedChoice maps true to exact option string when checkbox has labeled options', () => {
  const field: ScannedField = {
    fieldId: 'arbitration_chk',
    name: 'arbitration_chk',
    type: 'checkbox',
    label: 'Mutual Agreement to Arbitrate Claims',
    options: ['I Agree'],
    isRequired: true,
  };
  const resolved: ResolvedField = {
    fieldId: 'arbitration_chk',
    name: 'arbitration_chk',
    type: 'checkbox',
    label: 'Mutual Agreement to Arbitrate Claims',
    value: 'true',
    source: 'policy',
    resolvedByTier: 1,
    confidence: 1,
    isRequired: true,
  };

  const aligned = alignResolvedChoice(field, resolved);
  assert.equal(aligned.value, 'I Agree', 'Must map true to I Agree option text');
});

test('alignResolvedChoice maps true to I Agree when checkbox has read disclosure and agreement options', () => {
  const field: ScannedField = {
    fieldId: '046362c6-1192-43a6-a747-2552b7a03cec',
    name: '046362c6-1192-43a6-a747-2552b7a03cec',
    type: 'checkbox',
    label: 'Mutual Agreement to Arbitrate Claims and Privacy Agreements',
    options: [
      'I have read the Mutual Agreement to Arbitrate Claims and Privacy Agreement',
      'I Agree',
    ],
    isRequired: true,
  };
  const resolved: ResolvedField = {
    fieldId: '046362c6-1192-43a6-a747-2552b7a03cec',
    name: '046362c6-1192-43a6-a747-2552b7a03cec',
    type: 'checkbox',
    label: 'Mutual Agreement to Arbitrate Claims and Privacy Agreements',
    value: 'true',
    source: 'policy',
    resolvedByTier: 1,
    confidence: 1,
    isRequired: true,
  };

  const aligned = alignResolvedChoice(field, resolved);
  assert.equal(aligned.value, 'I Agree', 'Must select I Agree option text over disclosure statement');
});
