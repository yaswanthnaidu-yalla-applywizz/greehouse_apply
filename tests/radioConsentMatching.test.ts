import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesAffirmativeRadioOption } from '../src/submitter/formFiller.js';

test('matchesAffirmativeRadioOption matches agreement and onsite presence choices', () => {
  assert.equal(matchesAffirmativeRadioOption('Consent to Recording', 'I Agree'), true);
  assert.equal(matchesAffirmativeRadioOption('Consent to Recording', 'I Do Not Agree'), false);
  assert.equal(matchesAffirmativeRadioOption('Please confirm you are able to be in the office', 'I am able to be in the office'), true);
  assert.equal(matchesAffirmativeRadioOption('Please confirm you are able to be in the office', 'No I am seeking a fully remote position'), false);
  assert.equal(matchesAffirmativeRadioOption('What is your gender?', 'Female'), false);
  assert.equal(matchesAffirmativeRadioOption('Are you legally authorized to work in the United States?', 'Yes'), false);
});
