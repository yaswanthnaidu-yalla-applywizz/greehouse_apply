import { describe, it, expect } from 'vitest';
import { resolveStandardProfileAttribute } from '../src/resolver/tier1Supabase.js';
import type { ScannedField, CandidateProfile } from '../src/types/index.js';

describe('Candidate Location Preferences Rule', () => {
  it('matches location preference from raw_api_payload client location_preferences', () => {
    const profile: Partial<CandidateProfile> = {
      location: 'New York, NY',
      raw_api_payload: {
        client: {
          location_preferences: ['San Francisco, CA', 'Austin, TX', 'Remote'],
        },
      },
    };
    const field: ScannedField = {
      fieldId: 'location_pref',
      name: 'location_preference',
      type: 'select',
      label: 'Which office location do you prefer?',
      options: ['London, UK', 'Austin, TX', 'Dublin, Ireland'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('Austin, TX');
  });

  it('falls back to candidate profile location if client location_preferences do not match', () => {
    const profile: Partial<CandidateProfile> = {
      location: 'Seattle, WA',
      raw_api_payload: {
        client: {
          location_preferences: ['Atlanta, GA'],
        },
      },
    };
    const field: ScannedField = {
      fieldId: 'location_pref',
      name: 'location_preference',
      type: 'select',
      label: 'Preferred office location',
      options: ['New York, NY', 'Seattle, WA', 'Boston, MA'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('Seattle, WA');
  });

  it('returns first matching city/state from candidate profile location when matching loosely', () => {
    const profile: Partial<CandidateProfile> = {
      location: 'Memphis, Tennessee, United States',
    };
    const field: ScannedField = {
      fieldId: 'location_pref',
      name: 'office_location',
      type: 'select',
      label: 'Please select your preferred location',
      options: ['San Francisco (HQ)', 'New York', 'Tennessee - Remote', 'London'],
      isRequired: true,
    };
    const res = resolveStandardProfileAttribute(field, profile as any);
    expect(res).toBe('Tennessee - Remote');
  });
});
