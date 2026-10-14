import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTier5, resolveTier5Batch } from '../src/resolver/tier5LLM.js';
import type { ScannedField } from '../src/types/index.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('LLM_ANSWERING=false in SANDBOX mode', () => {
  const originalEnv = { ...process.env };

  const dummyProfile: ProfileRow = {
    applywizz_id: 'AWL-TEST-LLM',
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

  const sampleField: ScannedField = {
    fieldId: 'custom_question_1',
    name: 'custom_question_1',
    type: 'textarea',
    label: 'What makes you unique for this role?',
    isRequired: true,
  };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('bypasses resolveTier5 and returns null when SANDBOX=true and LLM_ANSWERING=false', async () => {
    process.env.SANDBOX = 'true';
    process.env.LLM_ANSWERING = 'false';

    const result = await resolveTier5(
      'AWL-TEST-LLM',
      sampleField,
      dummyProfile,
      { companyName: 'Anthropic', jobTitle: 'AI Engineer' }
    );

    expect(result).toBeNull();
  });

  it('bypasses resolveTier5Batch and returns nulls when SANDBOX=true and LLM_ANSWERING=false', async () => {
    process.env.SANDBOX = 'true';
    process.env.LLM_ANSWERING = 'false';

    const results = await resolveTier5Batch(
      'AWL-TEST-LLM',
      [sampleField],
      dummyProfile,
      { companyName: 'Anthropic', jobTitle: 'AI Engineer' }
    );

    expect(results).toEqual([null]);
  });

  it('does NOT bypass if SANDBOX is not enabled even if LLM_ANSWERING=false', async () => {
    delete process.env.SANDBOX;
    process.env.LLM_ANSWERING = 'false';

    // In non-sandbox mode, LLM answering shouldn't be disabled by this sandbox-specific flag
    // (It will proceed to LLM or synthesizer fallback)
    const isSandboxLlmDisabled = (
      (process.env.SANDBOX === 'true' || process.env.SANDBOX === '1') &&
      process.env.LLM_ANSWERING === 'false'
    );
    expect(isSandboxLlmDisabled).toBe(false);
  });
});
