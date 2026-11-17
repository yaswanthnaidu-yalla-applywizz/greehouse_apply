import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import type { ScannedField, ResolvedField } from '../src/types/index.js';

test('alignResolvedChoice blanks boolean values for URL type fields', () => {
  const field: ScannedField = {
    fieldId: 'linkedin_url',
    name: 'linkedin_url',
    type: 'text',
    label: 'LinkedIn Profile URL',
    isRequired: true,
    metadata: { inputType: 'url' },
  };
  const resolved: ResolvedField = {
    fieldId: 'linkedin_url',
    name: 'linkedin_url',
    type: 'text',
    label: 'LinkedIn Profile URL',
    value: 'Yes',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.9,
    isRequired: true,
  };

  const aligned = alignResolvedChoice(field, resolved);
  assert.equal(aligned.value, '', 'Must blank Yes value from URL field');
  assert.equal(aligned.source, 'unresolved', 'Must mark unresolved');
});

test('alignResolvedChoice blanks boolean values for GitHub Profile label', () => {
  const field: ScannedField = {
    fieldId: 'github_profile',
    name: 'github_profile',
    type: 'text',
    label: 'GitHub Profile',
    isRequired: true,
  };
  const resolved: ResolvedField = {
    fieldId: 'github_profile',
    name: 'github_profile',
    type: 'text',
    label: 'GitHub Profile',
    value: 'No',
    source: 'ai',
    resolvedByTier: 5,
    confidence: 0.9,
    isRequired: true,
  };

  const aligned = alignResolvedChoice(field, resolved);
  assert.equal(aligned.value, '', 'Must blank No value from GitHub profile field');
  assert.equal(aligned.source, 'unresolved');
});
