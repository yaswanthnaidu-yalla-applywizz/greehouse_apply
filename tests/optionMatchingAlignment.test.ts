import assert from 'node:assert/strict';
import { isSchoolField, alignResolvedChoice } from '../src/resolver/answerResolver.js';
import { resolveFromPayloadStructured } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/scanner/fieldScanner.js';
import type { ResolvedField } from '../src/types/resolver.js';

console.log('--- Running optionMatchingAlignment.test.ts ---');

// Test 1: isSchoolField should be false for an OPT extension question containing "institution"
const optQuestionField: ScannedField = {
  fieldId: 'question_36232077002',
  name: 'question_36232077002',
  label: 'If you are currently in OPT, are you eligible for a 24-month OPT extension based upon a degree from a qualifying U.S. institution in Science, Technology, Engineering or Mathematics?',
  type: 'select',
  isRequired: true,
  options: ['Yes', 'No', 'Not Applicable'],
};

assert.strictEqual(
  isSchoolField(optQuestionField),
  false,
  'isSchoolField must be false for questions with Yes/No/Not Applicable choices despite containing the word "institution"'
);

// Test 2: isSchoolField should be true for authentic school/university fields
const realSchoolField1: ScannedField = {
  fieldId: 'school--0',
  name: 'school--0',
  label: 'School',
  type: 'select',
  isRequired: true,
};
assert.strictEqual(isSchoolField(realSchoolField1), true, 'isSchoolField must be true for school--0');

const realSchoolField2: ScannedField = {
  fieldId: 'education_university',
  name: 'university',
  label: 'University or College Attended',
  type: 'text',
  isRequired: true,
};
assert.strictEqual(isSchoolField(realSchoolField2), true, 'isSchoolField must be true for university text field');

// Test 3: alignResolvedChoice must NOT bypass option matching when choice options exist
const invalidResolvedOpt: ResolvedField = {
  fieldId: optQuestionField.fieldId,
  name: optQuestionField.name,
  label: optQuestionField.label,
  type: 'select',
  value: 'University of South Florida',
  source: 'supabase',
  resolvedByTier: 1,
  confidence: 1,
  isRequired: true,
};

const aligned = alignResolvedChoice(optQuestionField, invalidResolvedOpt);
assert.notStrictEqual(
  aligned.value,
  'University of South Florida',
  'alignResolvedChoice must not preserve an answer that is not one of the available options'
);
assert.strictEqual(aligned.source, 'unresolved', 'Should be unresolved if answer does not match any valid option');

// Test 4: resolveFromPayloadStructured must not map the OPT extension question to university_name
const rawPayload = {
  additional_information: {
    university_name: 'University of South Florida',
    degree: "Master's",
  },
};

const payloadAnswer = resolveFromPayloadStructured(
  optQuestionField.label.toLowerCase(),
  optQuestionField.type,
  rawPayload,
  optQuestionField.options
);

assert.notStrictEqual(
  payloadAnswer,
  'University of South Florida',
  'resolveFromPayloadStructured must not map OPT extension question to university_name'
);

console.log('✅ All optionMatchingAlignment tests passed!');
