import assert from 'node:assert/strict';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';
import { isCountryField } from '../src/resolver/tier1Supabase.js';
import { isPhoneNumberField } from '../src/resolver/candidateEvidence.js';
import type { ScannedField } from '../src/scanner/fieldScanner.js';

console.log('--- Running pipelineFixes.test.ts ---');

// 1. Country Aliases
assert.strictEqual(
  matchChoiceOption('United Kingdom', ['UK', 'United States', 'Other']),
  'UK',
  'United Kingdom should match UK alias'
);
assert.strictEqual(
  matchChoiceOption('UK', ['United Kingdom', 'United States']),
  'United Kingdom',
  'UK should match United Kingdom alias'
);
assert.strictEqual(
  matchChoiceOption('United States of America', ['USA', 'Other']),
  'USA',
  'United States of America should match USA'
);

// 2. Consent & Acknowledgment Polarity
assert.strictEqual(
  matchChoiceOption('Yes', ['Acknowledge/Confirm']),
  'Acknowledge/Confirm',
  'Yes should match Acknowledge/Confirm'
);
assert.strictEqual(
  matchChoiceOption('Yes', ['I have reviewed and confirmed that all the information provided is accurate and complete.']),
  'I have reviewed and confirmed that all the information provided is accurate and complete.',
  'Yes should match review confirmation disclosure'
);
assert.strictEqual(
  matchChoiceOption('Yes', ['I confirm', 'I do not confirm', 'I am not a California Applicant']),
  'I confirm',
  'Yes should match I confirm over negative options'
);

// 3. Conversational Country Residence Questions
const countryField1: ScannedField = {
  fieldId: 'question_66839125',
  name: 'question_66839125',
  label: 'In which country/region are you currently based?',
  type: 'select',
  isRequired: true,
};
assert.strictEqual(
  isCountryField(countryField1),
  true,
  'isCountryField should match "In which country/region are you currently based?"'
);

const countryField2: ScannedField = {
  fieldId: 'question_8708579005',
  name: 'question_8708579005',
  label: 'What country do you currently reside in?',
  type: 'select',
  isRequired: true,
};
assert.strictEqual(
  isCountryField(countryField2),
  true,
  'isCountryField should match "What country do you currently reside in?"'
);

// 4. SMS Consent should NOT be isPhoneNumberField
const smsConsentField = {
  fieldId: 'sms_consent',
  name: 'sms_consent',
  label: 'Communication Preferences: Do you consent to receive SMS/text messages related to the recruitment process from Future Standard at the phone number provided in your application?',
};
assert.strictEqual(
  isPhoneNumberField(smsConsentField),
  false,
  'isPhoneNumberField must be false for SMS / text communication consent questions'
);

console.log('✅ All pipelineFixes test assertions passed!');
