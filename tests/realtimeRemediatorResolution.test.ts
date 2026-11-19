import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRemediationAnswer,
  type RemediationField,
  type RemediationCandidateContext,
} from '../src/submitter/realtimeRemediator.js';
import type { ProfileRow } from '../src/db/profiles.js';

const mockProfile: Partial<ProfileRow> = {
  applywizz_id: 'AWL-TEST-001',
  client_name: 'Jane Doe',
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane.doe@example.com',
  company_email: 'jane.doe@applywizz.ai',
  phone: '555-0199',
  work_authorization: 'US Citizen',
  requires_sponsorship: false,
  location: 'Austin, TX',
  country: 'United States',
  raw_api_payload: {
    additional_information: {
      work_authorization_status: 'US Citizen',
      requires_sponsorship: false,
      onsite_willingness: 'Hybrid or Onsite',
    },
  },
};

const mockContext: RemediationCandidateContext = {
  profile: mockProfile as ProfileRow,
  resumeFacts: {
    degrees: ['Bachelor of Science in Computer Science'],
    skills: ['TypeScript', 'Node.js', 'React'],
  },
  alreadyResolvedFields: [
    {
      fieldId: 'first_name',
      name: 'first_name',
      type: 'text',
      label: 'First Name',
      value: 'Jane',
      source: 'supabase',
      status: 'resolved',
      resolvedByTier: 1,
      confidence: 1.0,
    } as any,
    {
      fieldId: 'email',
      name: 'email',
      type: 'text',
      label: 'Email',
      value: 'jane.doe@applywizz.ai',
      source: 'supabase',
      status: 'resolved',
      resolvedByTier: 1,
      confidence: 1.0,
    } as any,
  ],
  jobTitle: 'Senior Full Stack Engineer',
  companyName: 'Acme Corp',
};

test('resolves uncommitted sponsorship dropdown to authorized choice', async () => {
  const sponsorshipField: RemediationField = {
    fieldId: 'question_sponsorship',
    label: 'Will you now or in the future require visa sponsorship to work in the US?',
    type: 'select',
    options: ['Yes, in the future', 'No, I am authorized to work without sponsorship'],
    currentValue: '',
  };

  const decision = await resolveRemediationAnswer(sponsorshipField, mockContext, {
    llmCallFn: async () => ({
      answer: 'No, I am authorized to work without sponsorship',
      confidence: 0.95,
      reasoning: 'Candidate is US Citizen and requires no sponsorship.',
    }),
  });

  assert.ok(decision, 'Decision should be returned');
  assert.equal(decision.value, 'No, I am authorized to work without sponsorship');
  assert.equal(decision.source, 'ai_realtime_remediated');
  assert.ok(decision.confidence >= 0.7);
  assert.ok(decision.issueFaced && decision.issueFaced.length > 5, 'issueFaced must be reported');
  assert.ok(decision.issueFixed && decision.issueFixed.length > 5, 'issueFixed must be reported');
});

test('captures explicit issueFaced and issueFixed reported by LLM', async () => {
  const customField: RemediationField = {
    fieldId: 'question_auth',
    label: 'Work Authorization',
    type: 'select',
    options: ['US Citizen', 'Non-Citizen'],
  };

  const decision = await resolveRemediationAnswer(customField, mockContext, {
    llmCallFn: async () => ({
      answer: 'US Citizen',
      confidence: 0.98,
      reasoning: 'Candidate is US Citizen.',
      issueFaced: 'Automation failed to match custom dropdown wording.',
      issueFixed: 'Selected US Citizen based on profile facts.',
    }),
  });

  assert.ok(decision);
  assert.equal(decision.issueFaced, 'Automation failed to match custom dropdown wording.');
  assert.equal(decision.issueFixed, 'Selected US Citizen based on profile facts.');
});

test('resolves hybrid willingness question using candidate context facts', async () => {
  const hybridField: RemediationField = {
    fieldId: 'question_onsite',
    label: 'Are you willing to work in a hybrid model (3 days onsite in Austin)?',
    type: 'radio',
    options: ['Yes', 'No'],
    currentValue: '',
  };

  const decision = await resolveRemediationAnswer(hybridField, mockContext, {
    llmCallFn: async () => ({
      answer: 'Yes',
      confidence: 0.92,
      reasoning: 'Candidate is located in Austin and willing to work hybrid.',
    }),
  });

  assert.ok(decision);
  assert.equal(decision.value, 'Yes');
  assert.equal(decision.source, 'ai_realtime_remediated');
});

test('fails closed when candidate context lacks information and confidence is low', async () => {
  const referralCodeField: RemediationField = {
    fieldId: 'secret_referral_code',
    label: 'Enter internal manager employee referral code (required)',
    type: 'text',
    currentValue: '',
  };

  const decision = await resolveRemediationAnswer(referralCodeField, mockContext, {
    llmCallFn: async () => ({
      answer: '',
      confidence: 0.2,
      reasoning: 'No employee referral code exists in candidate profile.',
    }),
  });

  assert.equal(decision, null, 'Must fail closed when confidence is below 0.70');
});

test('enforces choice matching: aligns near-match or fails closed if choice is invalid', async () => {
  const dropdownField: RemediationField = {
    fieldId: 'dropdown_choice',
    label: 'Select your primary work arrangement preference',
    type: 'select',
    options: ['Onsite Only', 'Hybrid (2-3 days)', 'Fully Remote'],
  };

  // LLM returns raw "Hybrid" which should align to "Hybrid (2-3 days)"
  const decision = await resolveRemediationAnswer(dropdownField, mockContext, {
    llmCallFn: async () => ({
      answer: 'Hybrid',
      confidence: 0.88,
      reasoning: 'Candidate prefers hybrid.',
    }),
  });

  assert.ok(decision);
  assert.equal(decision.value, 'Hybrid (2-3 days)');

  // LLM returns invalid choice not in options -> fails closed
  const invalidDecision = await resolveRemediationAnswer(dropdownField, mockContext, {
    llmCallFn: async () => ({
      answer: 'Work From Anywhere / Digital Nomad',
      confidence: 0.85,
      reasoning: 'Unmatched option.',
    }),
  });

  assert.equal(invalidDecision, null, 'Unmatched option must fail closed');
});

test('defaultLlmCall invokes Claude Messages API and parses structured JSON payload', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let capturedUrl = '';
  let capturedBody: any = null;
  let capturedHeaders: any = null;

  globalThis.fetch = async (url: any, init?: any) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(init?.body as string);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              answer: 'Hybrid (2-3 days)',
              confidence: 0.95,
              reasoning: 'Profile states hybrid preference.',
              issueFaced: 'Radio uncommitted on page.',
              issueFixed: 'Selected Hybrid based on profile.',
            }),
          },
        ],
      }),
    } as any;
  };

  const testField: RemediationField = {
    fieldId: 'work_pref',
    label: 'Work Arrangement',
    type: 'select',
    options: ['Onsite Only', 'Hybrid (2-3 days)', 'Remote'],
  };

  const decision = await resolveRemediationAnswer(testField, mockContext);
  assert.ok(decision);
  assert.equal(decision.value, 'Hybrid (2-3 days)');
  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  assert.ok(capturedBody.model.includes('haiku'));
  assert.ok(capturedHeaders['x-api-key'], 'API key must be present in headers');
});

test('resolves communicationConsent / SMS consent deterministically without failing closed', async () => {
  const smsField: RemediationField = {
    fieldId: 'input_type_radio_name_communicationConsent_',
    label: 'Phone Number',
    type: 'radio',
    options: [
      'Yes - I consent to receiving text messages',
      'No - I do not consent to receiving text messages',
    ],
  };

  // Even without an LLM call or if LLM throws, deterministic policy should resolve it
  const decision = await resolveRemediationAnswer(smsField, mockContext, {
    llmCallFn: async () => {
      throw new Error('LLM should not be called for deterministic SMS consent');
    },
  });

  assert.ok(decision, 'Decision should be returned for SMS communication consent');
  assert.equal(decision.value, 'No - I do not consent to receiving text messages');
  assert.equal(decision.confidence, 1.0);
  assert.equal(decision.source, 'ai_realtime_remediated');
});
