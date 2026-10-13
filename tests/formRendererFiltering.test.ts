import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isActionableCarouselField } from '../dashboard/utils/fieldFilters.js';
import type { ResolvedField } from '../dashboard/types.js';

describe('FormRenderer Carousel Filtering Rules', () => {
  const sampleFields: ResolvedField[] = [
    {
      fieldId: 'first_name',
      name: 'first_name',
      label: 'First Name',
      type: 'text',
      value: 'John',
      source: 'supabase',
      resolvedByTier: 1,
      isRequired: true,
      confidence: 1,
    },
    {
      fieldId: 'last_name',
      name: 'last_name',
      label: 'Last Name',
      type: 'text',
      value: 'Doe',
      source: 'supabase',
      resolvedByTier: 1,
      isRequired: true,
      confidence: 1,
    },
    {
      fieldId: 'email',
      name: 'email',
      label: 'Email',
      type: 'text',
      value: 'john@example.com',
      source: 'supabase',
      resolvedByTier: 1,
      isRequired: true,
      confidence: 1,
    },
    {
      fieldId: 'sponsorship',
      name: 'sponsorship',
      label: 'Will you now or in the future require sponsorship?',
      type: 'radio',
      value: '',
      source: 'unresolved',
      isRequired: true,
      confidence: 0,
    },
    {
      fieldId: 'why_company',
      name: 'why_company',
      label: 'Why do you want to work at Acme?',
      type: 'textarea',
      value: 'I have extensive experience in scalable distributed systems...',
      source: 'ai',
      resolvedByTier: 5,
      isRequired: true,
      confidence: 0.85,
    },
    {
      fieldId: 'diversity_statement',
      name: 'diversity_statement',
      label: 'Diversity & Inclusion Statement',
      type: 'textarea',
      value: 'Throughout my career I have actively mentored...',
      source: 'ai',
      resolvedByTier: 5,
      isRequired: false,
      confidence: 0.8,
    },
    {
      fieldId: 'linkedin',
      name: 'linkedin',
      label: 'LinkedIn Profile',
      type: 'text',
      value: 'https://linkedin.com/in/johndoe',
      source: 'supabase',
      resolvedByTier: 1,
      isRequired: false,
      confidence: 1,
    },
    {
      fieldId: 'custom_salary',
      name: 'custom_salary',
      label: 'Expected Compensation',
      type: 'text',
      value: '$130,000',
      source: 'manual',
      isRequired: false,
      isEdited: true,
      confidence: 1,
    },
  ];

  it('filters total fields down to exactly the actionable set in carousel mode', () => {
    const actionable = sampleFields.filter(isActionableCarouselField);
    assert.strictEqual(sampleFields.length, 8, 'Total form has 8 fields');
    assert.strictEqual(actionable.length, 4, 'Carousel shows exactly 4 actionable fields');

    const actionableIds = actionable.map((f) => f.fieldId);
    assert.deepStrictEqual(actionableIds, [
      'sponsorship',         // Required Unresolved
      'why_company',         // Required AI
      'diversity_statement', // Optional AI
      'custom_salary',       // Manually Edited
    ]);
  });

  it('excludes identity profile fields from carousel when resolved via Supabase', () => {
    const actionable = sampleFields.filter(isActionableCarouselField);
    const hasFirstName = actionable.some((f) => f.fieldId === 'first_name');
    const hasLastName = actionable.some((f) => f.fieldId === 'last_name');
    const hasEmail = actionable.some((f) => f.fieldId === 'email');
    assert.strictEqual(hasFirstName, false);
    assert.strictEqual(hasLastName, false);
    assert.strictEqual(hasEmail, false);
  });

  it('keeps manually edited fields in the carousel even if originally standard', () => {
    const editedIdentityField: ResolvedField = {
      fieldId: 'phone',
      name: 'phone',
      label: 'Phone Number',
      type: 'text',
      value: '555-123-4567',
      source: 'manual',
      isEdited: true,
      isRequired: true,
      confidence: 1,
    };
    assert.strictEqual(isActionableCarouselField(editedIdentityField), true);
  });
});
