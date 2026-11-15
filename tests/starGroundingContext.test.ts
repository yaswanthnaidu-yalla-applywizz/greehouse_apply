import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQuestionRelevantEvidence, supportedCandidatePhoneAnswer } from '../src/resolver/candidateEvidence.js';
import { createIngestTier5Stages } from '../src/resolver/tier5LLM.js';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';

describe('STAR Grounding with Candidate Evidence & QA Bank', () => {
  it('includes past QA bank entries when available for behavioral questions', () => {
    const profile = {
      clientName: 'Jane Doe',
      qaBankAnswers: [
        { question_label: 'Tell us about a time you optimized database queries', value: 'Reduced PostgreSQL query latency by 45% using composite indexes.' }
      ]
    };
    const evidence = buildQuestionRelevantEvidence(
      { fieldId: 'q', name: 'q', label: 'Have you worked with database optimization before?', type: 'textarea' },
      profile,
      'PostgreSQL database administrator with 5 years experience.'
    );
    assert.match(evidence, /Reduced PostgreSQL query latency by 45%/i);
  });

  const phoneField = { fieldId: 'phone', name: 'phone', label: 'Phone number', type: 'text' } as const;

  it('includes a validated profile-only phone as explicitly labeled evidence', () => {
    const evidence = buildQuestionRelevantEvidence(phoneField, { phone: '+1 (415) 555-0136' });
    assert.equal(evidence, 'Profile phone (candidate-provided): 4155550136');
  });

  it('keeps resume-only phone evidence available', () => {
    const evidence = buildQuestionRelevantEvidence(
      phoneField,
      {},
      'Jane Doe | jane@example.com | +1 (415) 555-0136'
    );
    assert.equal(evidence, 'Resume contact phone: 4155550136');
  });

  it('shows matching profile and resume phone facts without changing their source labels', () => {
    const evidence = buildQuestionRelevantEvidence(
      phoneField,
      { phone: '415-555-0136', country_code: '+1' },
      'Jane Doe | jane@example.com | +1 (415) 555-0136'
    );
    assert.equal(evidence, 'Resume contact phone: 4155550136\nProfile phone (candidate-provided): 4155550136');
  });

  it('exposes conflicting profile and resume phones instead of selecting a winner', () => {
    const evidence = buildQuestionRelevantEvidence(
      phoneField,
      { phone: '212-555-0199', country_code: '+1' },
      'Jane Doe | jane@example.com | +1 (415) 555-0136'
    );
    assert.match(evidence, /Resume contact phone: 4155550136/);
    assert.match(evidence, /Profile phone \(candidate-provided\): 2125550199/);
    assert.equal(evidence.split('\n').length, 2);
  });

  it('omits invalid profile phone values', () => {
    assert.equal(buildQuestionRelevantEvidence(phoneField, { phone: 'call me at 123' }), '');
    assert.equal(buildQuestionRelevantEvidence(phoneField, { phone: '1234567', country_code: '+1' }), '');
    assert.equal(buildQuestionRelevantEvidence(phoneField, { phone: '4155550136' }), '', 'local profile numbers need a calling code');
    assert.equal(
      buildQuestionRelevantEvidence(phoneField, { phone: '4155550136', country_code: '+1' }),
      'Profile phone (candidate-provided): 4155550136'
    );
  });

  it('does not treat calling-code or SMS-consent fields as phone-number fields', () => {
    const profile = { phone: '+1 (415) 555-0136' };
    const callingCode = buildQuestionRelevantEvidence(
      { ...phoneField, fieldId: 'phone_country_code', label: 'Phone country calling code' },
      profile
    );
    const smsConsent = buildQuestionRelevantEvidence(
      { ...phoneField, fieldId: 'sms_consent', label: 'Consent to receive SMS messages' },
      profile
    );
    assert.doesNotMatch(callingCode, /Profile phone|Resume contact phone/);
    assert.doesNotMatch(smsConsent, /Profile phone|Resume contact phone/);
  });

  it('validates phone answers against unambiguous profile or resume evidence', () => {
    assert.equal(supportedCandidatePhoneAnswer('415-555-0136', { phone: '+1 (415) 555-0136' }, {}, ''), '4155550136');
    assert.equal(supportedCandidatePhoneAnswer('212-555-0199', { phone: '212-555-0199', country_code: '+1' }, {
      rawSections: { summary: 'Jane | jane@example.com | +1 (415) 555-0136' },
    }), null, 'conflicting candidate sources fail closed');
    assert.equal(supportedCandidatePhoneAnswer('000-000-0000', { phone: '000-000-0000' }, {}, ''), null);
  });

  it('compares explicit profile and resume calling codes while preserving national answers', () => {
    const resume = (number: string) => ({ rawSections: { summary: `Jane | jane@example.com | ${number}` } });
    assert.equal(
      supportedCandidatePhoneAnswer('2079460000', { phone: '+1 2079460000' }, resume('+1 2079460000')),
      '2079460000',
      'matching international numbers resolve in national format'
    );
    assert.equal(
      supportedCandidatePhoneAnswer('2079460000', { phone: '+1 2079460000' }, resume('+44 2079460000')),
      null,
      'same national digits under different explicit calling codes conflict'
    );
    assert.equal(
      supportedCandidatePhoneAnswer('2079460000', { phone: '+1 2079460000' }, resume('2079460000')),
      '2079460000',
      'a resume without explicit country code is not assigned one by inference'
    );
    assert.equal(
      supportedCandidatePhoneAnswer('2079460000', { phone: '+1 2079460000' }, {
        rawSections: { summary: 'Jane | jane@example.com | +1 2079460000\nAlternate | +44 2079460000' },
      }),
      null,
      'multiple explicit calling codes for the same national digits are ambiguous'
    );
  });

  it('applies profile/resume phone validation in the ingest batch stage', async () => {
    const field = { ...phoneField, isRequired: true } as any;
    const makeStage = async (profile: Record<string, unknown>, answer: string, quote: string) => {
      const synthesizer = new LLMSynthesizer({ apiKey: 'offline-test', modelName: 'claude-haiku-test' });
      Object.defineProperty(synthesizer, 'runAnthropicPromptBatch', {
        value: async (_runKey: string, prompts: readonly { customId: string }[]) => ({
          status: 'ended',
          batchIds: [],
          failedIds: new Set<string>(),
          responses: new Map(prompts.map(({ customId }) => [customId, JSON.stringify({
            answers: [{ answer, confidence: 0.95, supportQuote: quote }],
          })])),
        }),
      });
      const item: any = {
        candidateId: 'offline-candidate',
        jobUrl: 'https://example.invalid/job',
        fieldKey: `offline-candidate|phone|${answer}`,
        field,
        original: { ...field, value: '', source: 'unresolved', resolvedByTier: null, confidence: 0 },
        profile,
        resumeText: '',
        jobTitle: 'Engineer',
        companyName: 'Example',
        questionFingerprint: 'phone-fingerprint',
      };
      return (await createIngestTier5Stages('offline-phone', synthesizer).haiku([item]))[0].answer;
    };

    const profileOnly = await makeStage(
      { phone: '+1 (415) 555-0136', resume_facts: {} },
      '4155550136',
      '4155550136'
    );
    assert.equal(profileOnly?.value, '4155550136');

    const conflicting = await makeStage(
      { phone: '212-555-0199', resume_facts: { rawSections: { summary: 'Jane | jane@example.com | +1 (415) 555-0136' } } },
      '2125550199',
      '2125550199'
    );
    assert.equal(conflicting, null, 'a numerically matching quote cannot override a conflicting candidate phone');

    const invalid = await makeStage({ phone: '000-000-0000', resume_facts: {} }, '0000000000', '0000000000');
    assert.equal(invalid, null, 'implausible phone shapes remain unresolved');
  });
});
