import { matchChoiceOption, matchSingleCheckboxOption } from '../src/utils/choiceOptions.js';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import type { ResolvedField, ScannedField } from '../src/types/index.js';

function assertEqual(actual: string | null, expected: string | null, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual(
  matchChoiceOption('Yes', ['I am authorized to work in the U.S.', 'No, I am not authorized to work in the U.S.']),
  'I am authorized to work in the U.S.',
  'work authorization affirmative alias'
);
assertEqual(
  matchChoiceOption('United States', ['Canada', 'United States of America']),
  'United States of America',
  'country alias'
);
assertEqual(
  matchChoiceOption("No, I don't have a disability", ['Yes', 'No']),
  'No',
  'disability negative alias'
);
assertEqual(
  matchChoiceOption('Asian', ['Asian (not Hispanic or Latino)', 'White (not Hispanic or Latino)']),
  'Asian (not Hispanic or Latino)',
  'race alias'
);
assertEqual(
  matchChoiceOption('Yes', ['Maybe', 'Not sure']),
  null,
  'ambiguous answer fails closed'
);
assertEqual(
  matchChoiceOption('$100,000 \u2013 $110,000', ['$90,000 - $100,000', '$100,000 - $110,000', '$110,000 - $120,000']),
  '$100,000 - $110,000',
  'en-dash matches ascii hyphen option in salary range'
);
assertEqual(
  matchChoiceOption('$100,000 - $110,000', ['$90,000 \u2013 $100,000', '$100,000 \u2013 $110,000', '$110,000 \u2013 $120,000']),
  '$100,000 \u2013 $110,000',
  'ascii hyphen matches en-dash option in salary range'
);

assertEqual(
  matchChoiceOption('No', ['I have never worked for an InterSystems client', 'Current client']),
  'I have never worked for an InterSystems client',
  'negative answer maps to a uniquely matching complete option'
);
assertEqual(
  matchSingleCheckboxOption('Website', ['Referral', 'Website']),
  'Website',
  'single checkbox choice matches exactly'
);
assertEqual(
  matchSingleCheckboxOption('Florida, California', ['Remote US', 'New York City Office']),
  null,
  'checkbox multi-values do not split or guess'
);

const requiredCheckbox: ScannedField = {
  fieldId: 'referral_source', name: 'referral_source', type: 'checkbox',
  label: 'How did you hear about us?', isRequired: true,
  options: ['Referral', 'Website'], optionsComplete: true,
};
const unmatchedCheckbox: ResolvedField = {
  fieldId: requiredCheckbox.fieldId, name: requiredCheckbox.name, type: requiredCheckbox.type,
  label: requiredCheckbox.label, value: 'Friend referral', source: 'supabase',
  resolvedByTier: 1, confidence: 1, isRequired: true,
};
const alignedCheckbox = alignResolvedChoice(requiredCheckbox, unmatchedCheckbox);
assertEqual(alignedCheckbox.value, '', 'unmatched required checkbox value is cleared');
if (alignedCheckbox.source !== 'unresolved' || alignedCheckbox.resolvedByTier !== null || alignedCheckbox.confidence !== 0) {
  throw new Error('unmatched required checkbox must be unresolved with no tier and zero confidence');
}
const consentCheckbox = {
  ...requiredCheckbox,
  fieldId: 'consent', name: 'consent', label: 'I agree',
  options: ['I agree', 'I do not agree'],
};
const booleanConsent: ResolvedField = {
  ...unmatchedCheckbox, fieldId: 'consent', name: 'consent', label: 'I agree', value: 'true',
};
assertEqual(
  alignResolvedChoice(consentCheckbox, booleanConsent).value,
  'true',
  'boolean consent checkbox values are preserved'
);
const incompleteCheckbox = { ...requiredCheckbox, optionsComplete: false };
assertEqual(alignResolvedChoice(incompleteCheckbox, unmatchedCheckbox).value, 'Friend referral', 'incomplete checkbox options preserve existing value validation behavior');

console.log('Choice option matching tests passed.');

