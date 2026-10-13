import { matchChoiceOption } from '../src/utils/choiceOptions.js';

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

console.log('Choice option matching tests passed.');

