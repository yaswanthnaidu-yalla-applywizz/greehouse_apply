import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchChoiceOption } from '../src/utils/choiceOptions.js';
import { matchDropdownOption } from '../src/submitter/formFiller.js';

describe('Canonical Choice Option Matching', () => {
  it('matches inverted word order correctly via token coverage', () => {
    const options = ['Software Engineer, Backend', 'Product Manager', 'Data Analyst'];
    const matched = matchChoiceOption('Analyst, Data', options);
    assert.equal(matched, 'Data Analyst');
  });

  it('matches prefix country aliases reliably', () => {
    const options = ['United States', 'Canada', 'Mexico'];
    const matched = matchChoiceOption('United States of America', options);
    assert.equal(matched, 'United States');
  });

  it('matches decline phrasing with exact polarity', () => {
    const options = ['Yes', 'No', 'I prefer not to say'];
    const matched = matchChoiceOption('Decline to self-identify', options);
    assert.equal(matched, 'I prefer not to say');
  });

  it('wires matchDropdownOption to use canonical matcher', () => {
    const options = ['Senior Software Engineer', 'Product Designer'];
    const res = matchDropdownOption(options, 'Software Engineer Senior');
    assert.ok(res.matchedOption === 'Senior Software Engineer');
  });
});
