import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import { applicationShouldBeFilteredOut } from '../src/resolver/needsReview.js';
import { fillSingleField } from '../src/submitter/formFiller.js';
import type { Page } from 'playwright';

test('optional questions remain blank and do not enter answer resolution or filtering', async () => {
  const field = {
    fieldId: 'optional_question',
    name: 'optional_question',
    label: 'Tell us more',
    type: 'textarea' as const,
    isRequired: false,
  };
  const result = await new AnswerResolver().resolveField('AWL-UNAVAILABLE', field);
  assert.equal(result.value, '');
  assert.equal(result.isRequired, false);
  assert.equal(result.source, 'unresolved');
  assert.equal(applicationShouldBeFilteredOut(Array.from({ length: 5 }, () => result)), false);
});

test('optional blank fields are not filled by submission defaults', async () => {
  const result = await fillSingleField({} as Page, {
    fieldId: 'referral',
    name: 'referral',
    label: 'How did you hear about us?',
    type: 'text',
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
    isRequired: false,
  }, 'AWL-TEST', []);
  assert.equal(result.valuePopulated, '');
  assert.equal(result.success, true);
});
