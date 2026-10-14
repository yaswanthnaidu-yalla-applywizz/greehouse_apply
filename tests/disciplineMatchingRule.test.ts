import { describe, it, expect } from 'vitest';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ScannedField, CandidateProfile } from '../src/types/index.js';

describe('Discipline Matching Rule', () => {
  it('matches discipline from candidate education major', () => {
    const profile: Partial<CandidateProfile> = {
      education: [
        {
          school: 'Christian Brothers University',
          degree: "Master's Degree",
          major: 'Information Science',
        } as any,
      ],
    };
    const field: ScannedField = {
      fieldId: 'discipline',
      name: 'discipline',
      type: 'select',
      label: 'Discipline',
      options: ['Accounting', 'Computer Science', 'Information Systems', 'Applied Health Services'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).not.toBeNull();
    expect(res).toBe('Information Systems');
  });

  it('falls back to raw_api_payload main_subject if education major is missing', () => {
    const profile: Partial<CandidateProfile> = {
      education: [],
      raw_api_payload: {
        additional_information: {
          main_subject: 'Master of Science in Computer Science',
        },
      },
    } as any;
    const field: ScannedField = {
      fieldId: 'discipline',
      name: 'discipline',
      type: 'select',
      label: 'Discipline',
      options: ['Accounting', 'Computer Science', 'Anthropology'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('Computer Science');
  });
});
