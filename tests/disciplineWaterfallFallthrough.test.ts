import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';

test('discipline select field falls through Tier 1 when candidate major is not in options', async () => {
  const profile = {
    id: 'test-profile',
    applywizz_id: 'test-123',
    email: 'test@example.com',
    location: 'Austin, Texas, United States',
    education: [
      {
        major: 'of Computer Applications',
        degree: 'Master of Computer Applications',
      },
    ],
    raw_api_payload: {
      additional_information: {
        main_subject: 'of Computer Applications',
      },
    },
  };

  const field: ScannedField = {
    fieldId: 'discipline--0',
    name: 'discipline--0',
    type: 'select',
    label: 'Discipline',
    isRequired: true,
    options: ['Accounting', 'Business Administration', 'History', 'Music'],
    optionsComplete: true,
  };

  // If candidate major 'of Computer Applications' does not match options,
  // Tier 1 should fall through (return null) so Tier 3/Tier 5 AI can pick the closest sensible option.
  const resolved = await resolveTier1(profile.applywizz_id, field, profile as any);
  assert.equal(resolved, null);
});

test('discipline select field resolves in Tier 1 when candidate major matches options', async () => {
  const profile = {
    id: 'test-profile-2',
    applywizz_id: 'test-456',
    email: 'test@example.com',
    location: 'Austin, Texas, United States',
    education: [
      {
        major: 'Computer Science',
        degree: 'Bachelor of Science in Computer Science',
      },
    ],
  };

  const field: ScannedField = {
    fieldId: 'discipline--0',
    name: 'discipline--0',
    type: 'select',
    label: 'Discipline',
    isRequired: true,
    options: ['Accounting', 'Computer Science', 'History', 'Music'],
    optionsComplete: true,
  };

  const resolved = await resolveTier1(profile.applywizz_id, field, profile as any);
  assert.equal(resolved?.value, 'Computer Science');
});
