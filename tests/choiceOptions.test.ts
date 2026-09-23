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

console.log('Choice option matching tests passed.');
