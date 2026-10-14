import { describe, it, expect } from 'vitest';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ScannedField, CandidateProfile } from '../src/types/index.js';

describe('Job Source ("How did you hear about us") Rule', () => {
  it('selects option containing LinkedIn when available', () => {
    const profile: Partial<CandidateProfile> = {};
    const field: ScannedField = {
      fieldId: 'how_did_you_hear',
      name: 'how_did_you_hear',
      type: 'select',
      label: 'How did you hear about this opportunity?',
      options: ['Career Fair', 'Glassdoor', 'LinkedIn', 'Referral', 'Other'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('LinkedIn');
  });

  it('selects fallback option when LinkedIn is not in options', () => {
    const profile: Partial<CandidateProfile> = {};
    const field: ScannedField = {
      fieldId: 'how_did_you_hear',
      name: 'how_did_you_hear',
      type: 'select',
      label: 'Where did you hear about this role?',
      options: ['Job Board', 'Friend or Family', 'Event'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('Job Board');
  });

  it('returns LinkedIn for free text input', () => {
    const profile: Partial<CandidateProfile> = {};
    const field: ScannedField = {
      fieldId: 'how_did_you_hear',
      name: 'how_did_you_hear',
      type: 'text',
      label: 'How did you hear about us?',
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('LinkedIn');
  });
});
