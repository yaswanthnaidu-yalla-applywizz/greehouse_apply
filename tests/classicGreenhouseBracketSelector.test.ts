import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMetadataSelector } from '../src/submitter/formFiller.js';

test('sanitizeMetadataSelector escapes brackets in CSS ID selectors', () => {
  assert.equal(sanitizeMetadataSelector('#question_69649528[]'), '#question_69649528\\[\\]');
  assert.equal(sanitizeMetadataSelector('#first_name'), '#first_name');
  assert.equal(sanitizeMetadataSelector('input[name="question_123[]"]'), 'input[name="question_123[]"]');
  // Avoid double escaping if already escaped
  assert.equal(sanitizeMetadataSelector('#question_69649528\\[\\]'), '#question_69649528\\[\\]');
  // Handle empty or undefined gracefully
  assert.equal(sanitizeMetadataSelector(''), '');
  assert.equal(sanitizeMetadataSelector(undefined), '');
});
