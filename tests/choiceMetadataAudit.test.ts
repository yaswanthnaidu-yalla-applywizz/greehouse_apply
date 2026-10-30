import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyChoiceMetadata } from '../scripts/auditChoiceMetadata.js';

describe('choice metadata audit', () => {
  it('flags Yes/No on a city fact question', () => {
    assert.equal(
      classifyChoiceMetadata({
        label: 'What city do you live in?',
        options: ['Yes', 'No'],
        templateOptions: null,
      }),
      'invalid-binary'
    );
  });

  it('flags Yes/No on a location preference fact question', () => {
    assert.equal(
      classifyChoiceMetadata({
        label: 'What location do you plan to work from?',
        options: ['Yes', 'No'],
        templateOptions: null,
      }),
      'invalid-binary'
    );
  });

  it('does not flag legitimate binary relocation questions', () => {
    assert.equal(
      classifyChoiceMetadata({
        label: 'Are you open to relocation for this role?',
        options: ['Yes', 'No'],
        templateOptions: ['Yes', 'No'],
      }),
      'valid'
    );
  });

  it('does not flag a binary acknowledgement that mentions salary', () => {
    assert.equal(
      classifyChoiceMetadata({
        label: 'Our base salary range is $175,000-$195,000. Do you acknowledge and agree that this aligns with your expectations?',
        options: ['Yes', 'No'],
        templateOptions: null,
      }),
      'valid'
    );
  });

  it('reports a safe replacement when the template has authoritative options', () => {
    assert.equal(
      classifyChoiceMetadata({
        label: 'What city do you live in?',
        options: ['Yes', 'No'],
        templateOptions: ['New York', 'London'],
      }),
      'replace-from-template'
    );
  });
});
