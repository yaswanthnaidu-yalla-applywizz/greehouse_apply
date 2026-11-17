import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';

test('matchChoiceOption maps No to negative sponsorship choice phrase', () => {
  const options = [
    'Requires sponsorship for employment authorization',
    'Does not require sponsorship',
  ];
  const matched = matchChoiceOption('No', options);
  assert.equal(matched, 'Does not require sponsorship');
});

test('matchChoiceOption maps Yes to affirmative sponsorship choice phrase', () => {
  const options = [
    'Requires sponsorship for employment authorization',
    'Does not require sponsorship',
  ];
  const matched = matchChoiceOption('Yes', options);
  assert.equal(matched, 'Requires sponsorship for employment authorization');
});
