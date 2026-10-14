import { describe, it, expect } from 'vitest';
import { resolveTier1 } from '../src/resolver/tier1Supabase.js';
import type { ScannedField } from '../src/types/index.js';

describe('Referral and Company Connections Negative Resolution', () => {
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

  it('resolves "Do you know anyone currently at Glean?" to "No"', async () => {
    const field: ScannedField = {
      fieldId: 'know_anyone',
      name: 'know_anyone',
      type: 'select',
      label: 'Do you know anyone currently at Glean?',
      options: ['Yes', 'No'],
      isRequired: true,
    };

    const resolved = await resolveTier1('AWL-TEST', field, dummyProfile);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('No');
  });

  it('resolves "Were you referred to this role by a current Capco Employee?" to "No"', async () => {
    const field: ScannedField = {
      fieldId: 'referred_capco',
      name: 'referred_capco',
      type: 'select',
      label: 'Were you referred to this role by a current Capco Employee? If yes, please confirm the employee’s Capco email address.',
      options: ['Yes', 'No'],
      isRequired: true,
    };

    const resolved = await resolveTier1('AWL-TEST', field, dummyProfile);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('No');
  });
});
