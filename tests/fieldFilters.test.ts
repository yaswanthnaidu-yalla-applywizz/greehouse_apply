import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isActionableCarouselField } from '../dashboard/utils/fieldFilters.js';
import type { ResolvedField } from '../dashboard/types.js';

describe('isActionableCarouselField', () => {
  it('returns true for required unresolved fields', () => {
    const field: ResolvedField = {
      fieldId: 'q1',
      name: 'q1',
      label: 'Sponsorship Question',
      type: 'radio',
      value: '',
      source: 'unresolved',
      isRequired: true,
      confidence: 0,
    };
    assert.strictEqual(isActionableCarouselField(field), true);
  });

  it('returns true for required AI-resolved fields', () => {
    const field: ResolvedField = {
      fieldId: 'q2',
      name: 'q2',
      label: 'Why this role?',
      type: 'textarea',
      value: 'I am excited about this opportunity...',
      source: 'ai',
      resolvedByTier: 5,
      isRequired: true,
      confidence: 0.85,
    };
    assert.strictEqual(isActionableCarouselField(field), true);
  });

  it('returns true for optional AI-resolved fields', () => {
    const field: ResolvedField = {
      fieldId: 'q3',
      name: 'q3',
      label: 'Additional Information',
      type: 'textarea',
      value: 'Relevant experience includes...',
      source: 'ai',
      resolvedByTier: 5,
      isRequired: false,
      confidence: 0.8,
    };
    assert.strictEqual(isActionableCarouselField(field), true);
  });

  it('returns true for manually edited fields regardless of requirement or source', () => {
    const field1: ResolvedField = {
      fieldId: 'q4',
      name: 'q4',
      label: 'Custom Notes',
      type: 'text',
      value: 'Operator notes',
      source: 'manual',
      isRequired: false,
      isEdited: true,
    };
    assert.strictEqual(isActionableCarouselField(field1), true);

    const field2: ResolvedField = {
      fieldId: 'q5',
      name: 'first_name',
      label: 'First Name',
      type: 'text',
      value: 'Alex',
      source: 'supabase',
      isRequired: true,
      isEdited: true,
    };
    assert.strictEqual(isActionableCarouselField(field2), true);
  });

  it('returns false for required fields resolved from Supabase / candidate profile', () => {
    const field: ResolvedField = {
      fieldId: 'first_name',
      name: 'first_name',
      label: 'First Name',
      type: 'text',
      value: 'John',
      source: 'supabase',
      resolvedByTier: 1,
      isRequired: true,
      confidence: 1,
    };
    assert.strictEqual(isActionableCarouselField(field), false);
  });

  it('returns false for optional fields resolved from Supabase / resume', () => {
    const field: ResolvedField = {
      fieldId: 'website',
      name: 'website',
      label: 'Personal Website',
      type: 'text',
      value: 'https://example.com',
      source: 'supabase',
      resolvedByTier: 1,
      isRequired: false,
      confidence: 1,
    };
    assert.strictEqual(isActionableCarouselField(field), false);
  });

  it('returns false for optional unresolved fields (do not distract operator)', () => {
    const field: ResolvedField = {
      fieldId: 'optional_notes',
      name: 'optional_notes',
      label: 'Optional Comments',
      type: 'text',
      value: '',
      source: 'unresolved',
      isRequired: false,
      confidence: 0,
    };
    assert.strictEqual(isActionableCarouselField(field), false);
  });
});
