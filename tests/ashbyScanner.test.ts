import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAshbyFieldToScannedField, validateAshbyApiResponse } from '../src/scanner/ashbyScanner.js';

test('maps ShortText to text type', () => {
  const field = mapAshbyFieldToScannedField({
    path: 'custom_question_abc',
    title: 'Years of experience',
    type: 'ShortText',
    isRequired: true,
    selectableValues: []
  });
  assert.equal(field.type, 'text');
  assert.equal(field.isRequired, true);
  assert.equal(field.label, 'Years of experience');
  assert.equal(field.fieldId, 'custom_question_abc');
});

test('maps Select with options', () => {
  const field = mapAshbyFieldToScannedField({
    path: 'custom_question_xyz',
    title: 'Work authorization',
    type: 'Select',
    isRequired: true,
    selectableValues: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]
  });
  assert.equal(field.type, 'select');
  assert.deepEqual(field.options, ['Yes', 'No']);
});

test('maps _systemfield_resume to file type', () => {
  const field = mapAshbyFieldToScannedField({
    path: '_systemfield_resume',
    title: 'Resume',
    type: 'File',
    isRequired: true,
    selectableValues: []
  });
  assert.equal(field.type, 'file');
  assert.equal(field.fieldId, '_systemfield_resume');
});

test('maps Boolean to checkbox', () => {
  const field = mapAshbyFieldToScannedField({
    path: 'consent_terms',
    title: 'I agree to the terms',
    type: 'Boolean',
    isRequired: true
  });
  assert.equal(field.type, 'checkbox');
});

test('maps Location to location_autocomplete', () => {
  const field = mapAshbyFieldToScannedField({
    path: '_systemfield_location',
    title: 'Location',
    type: 'Location',
    isRequired: true
  });
  assert.equal(field.type, 'location_autocomplete');
});

test('throws on missing applicationForm in API response', () => {
  assert.throws(() => {
    validateAshbyApiResponse({});
  }, /missing applicationForm/i);
});
