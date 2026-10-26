import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAshbySystemField } from '../src/resolver/answerResolver.js';
import type { ScannedField } from '../src/types/index.js';

test('resolveAshbySystemField resolves _systemfield_name', () => {
  const field: ScannedField = {
    fieldId: '_systemfield_name',
    name: '_systemfield_name',
    type: 'text',
    label: 'Full Name',
    isRequired: true,
  };
  const profile: any = { first_name: 'John', last_name: 'Doe' };
  const res = resolveAshbySystemField(field, profile, true);
  assert.equal(res?.value, 'John Doe');
  assert.equal(res?.source, 'supabase');
  assert.equal(res?.resolvedByTier, 1);
});

test('resolveAshbySystemField resolves _systemfield_email', () => {
  const field: ScannedField = {
    fieldId: '_systemfield_email',
    name: '_systemfield_email',
    type: 'text',
    label: 'Email Address',
    isRequired: true,
  };
  const profile: any = { company_email: 'john.doe@company.com' };
  const res = resolveAshbySystemField(field, profile, true);
  assert.equal(res?.value, 'john.doe@company.com');
});

test('resolveAshbySystemField resolves _systemfield_resume to __FILE_UPLOAD__', () => {
  const field: ScannedField = {
    fieldId: '_systemfield_resume',
    name: '_systemfield_resume',
    type: 'file',
    label: 'Resume',
    isRequired: true,
  };
  const profile: any = {};
  const res = resolveAshbySystemField(field, profile, true);
  assert.equal(res?.value, '__FILE_UPLOAD__');
  assert.equal(res?.type, 'file');
});

test('resolveAshbySystemField ignores non-system fields', () => {
  const field: ScannedField = {
    fieldId: 'custom_question_123',
    name: 'custom_question_123',
    type: 'text',
    label: 'Years of Experience',
    isRequired: true,
  };
  const profile: any = { client_name: 'John Doe' };
  const res = resolveAshbySystemField(field, profile, true);
  assert.equal(res, null);
});
