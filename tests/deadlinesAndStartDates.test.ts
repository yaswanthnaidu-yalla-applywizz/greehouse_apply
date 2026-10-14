import { describe, it, expect } from 'vitest';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';

describe('Deadlines and Dynamic Start Dates Resolution', () => {
  const dummyProfile = {
    applywizz_id: 'AWL-TEST',
    client_name: 'Test Candidate',
    first_name: 'Test',
    last_name: 'Candidate',
    email: 'test@example.com',
    location: 'Dallas, Texas, United States',
    country: 'United States',
    phone: '1234567890',
    work_authorization: 'US Citizen',
    requires_sponsorship: false,
    raw_api_payload: {
      client: {},
      additional_information: {},
      demographics: {},
      education: [],
    },
  } as any;

  it('resolves deadlines or timeline considerations to "None"', async () => {
    const field: ScannedField = {
      fieldId: 'deadline_q',
      name: 'deadline_q',
      type: 'textarea',
      label: 'Do you have any deadlines or timeline considerations we should be aware of?',
      isRequired: false,
    };

    const resolved = await resolveTier1('AWL-TEST', field, dummyProfile);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('None');
    expect(resolved?.source).toBe('supabase');
  });

  it('resolves start date to exactly 7 days from now', async () => {
    const field: ScannedField = {
      fieldId: 'start_date_q',
      name: 'start_date_q',
      type: 'text',
      label: 'When can you start?',
      isRequired: true,
    };

    const resolved = await resolveTier1('AWL-TEST', field, dummyProfile);
    expect(resolved).not.toBeNull();
    
    const expectedDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    expect(resolved?.value).toBe(expectedDate);
    expect(resolved?.source).toBe('supabase');
  });
});
