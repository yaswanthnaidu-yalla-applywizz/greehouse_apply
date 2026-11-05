import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAshbySystemField, alignResolvedChoice } from '../src/resolver/answerResolver.js';
import type { ScannedField, ResolvedField } from '../src/types/index.js';

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

test('resolveAshbySystemField resolves _systemfield_location from profile.location', () => {
  const field: ScannedField = {
    fieldId: '_systemfield_location',
    name: '_systemfield_location',
    type: 'select',
    label: 'Location',
    isRequired: true,
  };
  const profile: any = { location: 'Phoenix, Arizona, United States' };
  const res = resolveAshbySystemField(field, profile, true);
  assert.equal(res?.value, 'Phoenix, Arizona, United States');
  assert.equal(res?.source, 'supabase');
  assert.equal(res?.resolvedByTier, 1);
});

test('alignResolvedChoice preserves _systemfield_location select value when options are absent', () => {
  const field: ScannedField = {
    fieldId: '_systemfield_location',
    name: '_systemfield_location',
    type: 'select',
    label: 'Location',
    isRequired: true,
  };
  const resolved: ResolvedField = {
    fieldId: '_systemfield_location',
    name: '_systemfield_location',
    type: 'select',
    label: 'Location',
    value: 'Phoenix, Arizona, United States',
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1,
    isRequired: true,
  };
  const aligned = alignResolvedChoice(field, resolved);
  assert.equal(aligned.value, 'Phoenix, Arizona, United States');
  assert.equal(aligned.source, 'supabase');
});
