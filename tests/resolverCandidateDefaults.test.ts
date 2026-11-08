import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import { resolveDeterministicPolicy } from '../src/resolver/deterministicPolicies.js';
import { classifyFieldIntent } from '../src/resolver/fieldIntent.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import type { ScannedField } from '../src/types/index.js';

const profile = { applywizz_id: 'AWL-TEST', client_name: 'Test Candidate' } as any;

test('candidate-specific defaults wait until after evidence tiers', () => {
  const cases: Array<[string, ScannedField, string]> = [
    ['medical', { fieldId: 'medical', name: 'medical', label: 'Are you enrolled in a medical coverage plan?', type: 'radio', options: ['Yes', 'No'], isRequired: true }, 'Yes'],
    ['references', { fieldId: 'references', name: 'references', label: 'List of professional references', type: 'textarea', isRequired: true }, 'N/A'],
    ['deadlines', { fieldId: 'deadlines', name: 'deadlines', label: 'Any deadlines or timeline considerations?', type: 'text', isRequired: true }, 'None'],
  ];
  for (const [name, field, expected] of cases) {
    assert.equal(resolveStandardProfileAttribute(field, profile), null, `${name} must miss Tier 1`);
    const policy = resolveDeterministicPolicy(field, classifyFieldIntent(field), profile);
    assert.equal(policy?.value, expected, `${name} fallback`);
    assert.equal(policy?.source, 'policy');
  }
});

test('candidate QA evidence wins over a medical coverage fallback', async () => {
  const field: ScannedField = {
    fieldId: 'medical', name: 'medical', label: 'Are you enrolled in a medical coverage plan?',
    type: 'radio', options: ['Yes', 'No'], isRequired: true,
  };
  const resolved = await new AnswerResolver().resolveFormFields(
    'AWL-TEST', [field], { companyName: 'Company', jobTitle: 'Engineer' },
    { profile, parsedResume: null, qaEntries: [{ applywizz_id: 'AWL-TEST', question_fingerprint: 'medical-no', question_label: field.label, field_type: 'radio', value: 'No', source: 'manual' }] },
    { mode: 'shadow' }
  );
  assert.equal(resolved[0].value, 'No');
  assert.equal(resolved[0].source, 'fuzzy_match');
});
