import { describe, it, expect } from 'vitest';
import { resolvePreTierField } from '../src/resolver/answerResolver.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import type { ScannedField, ProfileRow } from '../src/types/index.js';

describe('Corporate Policies Integration', () => {
  const profile: ProfileRow = {
    id: '123',
    applywizz_id: 'AWL-123',
    first_name: 'Test',
    last_name: 'User',
    email: 'test@example.com',
    phone: '5551234567',
    location: 'Austin, TX',
    country: 'United States',
    education: [],
    work_experience: [],
    skills: [],
    resume_path: '',
    resume_text: '',
    raw_api_payload: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as any;

  it('resolves corporate policies at Pre-Tier with Tier 1 and 1.0 confidence', () => {
    const priorInterviewField: ScannedField = {
      fieldId: 'q_interview',
      name: 'prior_interview',
      type: 'radio',
      label: 'Have you interviewed with this company before?',
      options: ['Yes', 'No'],
      isRequired: true,
    };
    const resolved = resolvePreTierField(priorInterviewField, profile, true);
    expect(resolved).not.toBeNull();
    expect(resolved?.value).toBe('No');
    expect(resolved?.resolvedByTier).toBe(1);
    expect(resolved?.confidence).toBe(1.0);
  });

  it('clamps conflicting downstream resolution in AnswerResolver.resolveField', async () => {
    const resolver = new AnswerResolver();
    const smsConsentField: ScannedField = {
      fieldId: 'q_sms',
      name: 'sms_consent',
      type: 'select',
      label: 'Do you consent to receiving SMS messages regarding this job?',
      options: ['Yes', 'No'],
      isRequired: true,
    };

    const resolved = await resolver.resolveField('AWL-123', smsConsentField, {
      profile,
      parsedResume: { structured: {}, raw_text: '' } as any,
      qaEntries: [],
      jobContext: { companyName: 'TestCo', jobTitle: 'Engineer' },
    });
    expect(resolved.value).toBe('No');
    expect(resolved.resolvedByTier).toBe(1);
  });
});
