import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ResolvedField, ScannedField } from '../src/types/index.js';
import { finalizeTier5WithEscalation } from '../src/resolver/tier5LLM.js';
import { LLMSynthesizer, classifyTier5Question, decideTier5Answer } from '../src/resolver/llmSynthesizer.js';

const field: ScannedField = {
  fieldId: 'q1',
  name: 'q1',
  type: 'select',
  label: 'Work authorization',
  isRequired: true,
  options: ['Authorized', 'Not authorized'],
};

function answer(value: string, confidence: number, model = 'claude-haiku-5-5'): ResolvedField & { supportQuote: string } {
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value,
    source: 'ai',
    resolvedByTier: 5,
    confidence,
    isRequired: true,
    supportQuote: value === 'Authorized' ? 'Authorized' : '',
    tier5Provenance: { fieldKey: 'key', winningModel: model, attempts: [] },
  };
}

describe('shared Tier 5 escalation finalization', () => {
  it('accepts primary confidence at 0.80 without escalating', async () => {
    let escalations = 0;
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.8), async () => {
      escalations++;
      return answer('Authorized', 0.9, 'deepseek/deepseek-r1-0528');
    }, { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' });
    assert.equal(result?.value, 'Authorized');
    assert.equal(result?.confidence, 0.8);
    assert.equal(escalations, 0);
  });

  it('escalates primary confidence 0.69 and accepts DeepSeek at 0.70', async () => {
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.69), async () =>
      answer('Authorized', 0.70, 'deepseek/deepseek-r1-0528'), { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' }
    );
    assert.equal(result?.value, 'Authorized');
    assert.equal(result?.confidence, 0.70);
    assert.equal(result?.tier5Provenance?.winningModel, 'deepseek/deepseek-r1-0528');
  });

  it('escalates an invalid exact choice', async () => {
    let escalations = 0;
    const result = await finalizeTier5WithEscalation(field, answer('Maybe', 0.95), async () => {
      escalations++;
      return answer('Authorized', 0.8, 'deepseek/deepseek-r1-0528');
    }, { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' });
    assert.equal(escalations, 1);
    assert.equal(result?.value, 'Authorized');
  });

  it('escalates an unresolved primary answer', async () => {
    const result = await finalizeTier5WithEscalation(field, null, async () =>
      answer('Authorized', 0.8, 'deepseek/deepseek-r1-0528'), { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' }
    );
    assert.equal(result?.value, 'Authorized');
    assert.equal(result?.tier5Provenance?.attempts[0].status, 'rejected');
  });

  it('leaves the field unresolved when DeepSeek fails; it does not retain a 0.69 primary answer', async () => {
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.69), async () => null, { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' });
    assert.equal(result, null);
  });

  it('leaves the field unresolved when DeepSeek confidence is below 0.70', async () => {
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.69), async () =>
      answer('Authorized', 0.69, 'deepseek/deepseek-r1-0528'), { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' }
    );
    assert.equal(result, null);
  });

  it('accepts required factual answers at 0.70 and escalates 0.69', async () => {
    const atThreshold = await finalizeTier5WithEscalation(field, answer('Authorized', 0.70), async () => null, { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' });
    assert.equal(atThreshold?.value, 'Authorized');
    let calls = 0;
    const belowThreshold = await finalizeTier5WithEscalation(field, answer('Authorized', 0.69), async () => {
      calls++;
      return answer('Authorized', 0.70, 'deepseek/deepseek-r1-0528');
    }, { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' });
    assert.equal(calls, 1);
    assert.equal(belowThreshold?.confidence, 0.70);
  });

  it('rejects required factual answers without evidence or confidence', async () => {
    const noEvidence = await finalizeTier5WithEscalation(field, answer('Authorized', 0.95), async () => null);
    const noConfidence = await finalizeTier5WithEscalation(field, { ...answer('Authorized', 0.95), confidence: Number.NaN }, async () =>
      answer('Authorized', 0.70, 'deepseek/deepseek-r1-0528'), { evidence: 'profile.work_authorization: Authorized', primarySupportQuote: 'Authorized' });
    assert.equal(noEvidence, null);
    assert.equal(noConfidence?.confidence, 0.70);
  });

  it('keeps optional factual failures blank without escalation', async () => {
    const optional = { ...field, isRequired: false };
    let calls = 0;
    const result = await finalizeTier5WithEscalation(optional, answer('Authorized', 0.69), async () => {
      calls++;
      return answer('Authorized', 0.9, 'deepseek/deepseek-r1-0528');
    }, { evidence: 'profile.work_authorization: Authorized' });
    assert.equal(result, null);
    assert.equal(calls, 0);
  });

  it('requires explicit question-relevant evidence and rejects contradicted or unrelated facts', async () => {
    const unrelated = decideTier5Answer({ field, answer: 'Authorized', evidence: 'profile.location: Austin', supportQuote: 'Austin', confidence: 0.95, stage: 'haiku' });
    const invalidCitation = decideTier5Answer({ field, answer: 'Authorized', evidence: 'profile.work_authorization: Not authorized', supportQuote: 'Legally authorized', confidence: 0.95, stage: 'haiku' });
    const contradicted = decideTier5Answer({ field, answer: 'Authorized', evidence: 'profile.work_authorization: Not authorized', supportQuote: 'Not authorized', confidence: 0.95, stage: 'haiku' });
    const supported = decideTier5Answer({ field, answer: 'Authorized', evidence: 'profile.work_authorization: Authorized', supportQuote: 'Authorized', confidence: 0.95, stage: 'haiku' });
    const paraphrase = decideTier5Answer({
      field: { ...field, type: 'text', options: undefined, label: 'Are you authorized to work in the United States?' },
      answer: 'I am legally eligible to work in the United States.',
      evidence: 'profile.work_authorization: Authorized to work in the United States',
      supportQuote: 'Authorized to work in the United States', confidence: 0.95, stage: 'haiku',
    });
    assert.equal(unrelated.accepted, false);
    assert.equal(unrelated.reason, 'irrelevant_evidence');
    assert.equal(invalidCitation.accepted, false);
    assert.equal(invalidCitation.reason, 'unsupported_evidence');
    assert.equal(contradicted.accepted, false);
    assert.equal(contradicted.reason, 'contradictory_evidence');
    assert.equal(supported.accepted, true);
    assert.equal(paraphrase.accepted, true, 'real supporting quote permits a supported paraphrase');

    const authorizationField: ScannedField = {
      ...field, type: 'select', options: ['Yes', 'No'],
      label: 'What is your work authorization? Are you authorized to work in United States?',
    };
    const authorizationDecision = (answerText: string, evidenceText: string, quote: string) => decideTier5Answer({
      field: authorizationField, answer: answerText,
      evidence: `profile.work_authorization: ${evidenceText}`, supportQuote: quote,
      confidence: 0.95, stage: 'haiku',
    });
    assert.equal(authorizationDecision('Yes', 'Authorized to work in the United States', 'Authorized to work in the United States').accepted, true);
    assert.equal(authorizationDecision('Yes', 'I do not need sponsorship, but I am authorized to work in the US', 'I do not need sponsorship, but I am authorized to work in the US').accepted, true);
    assert.equal(authorizationDecision('No', 'I do not need sponsorship, but I am not authorized to work in the US', 'I do not need sponsorship, but I am not authorized to work in the US').accepted, true);
    assert.equal(authorizationDecision('Yes', 'No work authorization', 'No work authorization').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('Yes', 'Lack of work authorization', 'Lack of work authorization').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('Yes', 'No current valid work authorization', 'No current valid work authorization').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('Yes', "I don't currently have work authorization", "I don't currently have work authorization").reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('Yes', 'I lack work authorization', 'I lack work authorization').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('Yes', 'I lack current work authorization', 'I lack current work authorization').reason, 'contradictory_evidence');
    const conflictingAuthorization = decideTier5Answer({
      field: authorizationField,
      answer: 'Yes',
      evidence: 'profile.work_authorization: Authorized to work in the United States\nresume.work_authorization: Not authorized to work in the United States',
      supportQuote: 'Authorized to work in the United States',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(conflictingAuthorization.reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('No', 'No current valid work authorization', 'No current valid work authorization').accepted, true);
    assert.equal(authorizationDecision('Yes', 'I am not without work authorization', 'I am not without work authorization').reason, 'unsupported_evidence');
    assert.equal(authorizationDecision('Yes', 'I have current valid work authorization', 'I have current valid work authorization').accepted, true);
    assert.equal(authorizationDecision('Yes', 'My work authorization is pending', 'My work authorization is pending').reason, 'unsupported_evidence');
    assert.equal(authorizationDecision('Yes', 'I am a US citizen', 'I am a US citizen').accepted, true);
    assert.equal(authorizationDecision('No', 'Authorized to work in the United States', 'Authorized to work in the United States').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('No', 'Not authorized to work in the United States', 'Not authorized to work in the United States').accepted, true);
    assert.equal(authorizationDecision('Yes', 'Not authorized to work in the United States', 'Not authorized to work in the United States').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('I am legally eligible to work in the United States.', 'Not authorized to work in the United States', 'Not authorized to work in the United States').reason, 'contradictory_evidence');
    assert.equal(authorizationDecision('Yes', 'United States work status is pending', 'United States work status is pending').reason, 'unsupported_evidence');

    let requiredEscalations = 0;
    const required = await finalizeTier5WithEscalation(field, answer('Authorized', 0.95), async () => {
      requiredEscalations++;
      return null;
    }, { evidence: 'profile.location: Austin', primarySupportQuote: 'Austin' });
    let optionalEscalations = 0;
    const optional = await finalizeTier5WithEscalation({ ...field, isRequired: false }, answer('Authorized', 0.95), async () => {
      optionalEscalations++;
      return null;
    }, { evidence: 'profile.location: Austin', primarySupportQuote: 'Austin' });
    assert.equal(required, null);
    assert.equal(requiredEscalations, 1);
    assert.equal(optional, null);
    assert.equal(optionalEscalations, 0);
  });

  it('uses structured evidence families for work authorization and yes/no facts', () => {
    const eligibilityField: ScannedField = {
      ...field,
      type: 'radio',
      label: 'Are you legally eligible to work in the United States?',
      options: ['Yes', 'No'],
    };
    const citizenEvidence = 'profile.work_authorization: US citizen';
    const citizen = decideTier5Answer({
      field: eligibilityField, answer: 'Yes', evidence: citizenEvidence, supportQuote: 'US citizen',
      confidence: 0.99, stage: 'haiku',
    });
    assert.equal(citizen.accepted, true);

    const veteranField: ScannedField = {
      ...eligibilityField, label: 'Are you a veteran?',
    };
    const veteran = (answerText: string, value: string) => decideTier5Answer({
      field: veteranField, answer: answerText,
      evidence: `profile.veteran: ${value}`, supportQuote: value,
      confidence: 0.99, stage: 'haiku',
    });
    assert.equal(veteran('Yes', 'Not a veteran').reason, 'contradictory_evidence');
    assert.equal(veteran('No', 'Not a veteran').accepted, true);
    assert.equal(veteran('Yes', 'Veteran status unknown').reason, 'unsupported_evidence');
    const conflictingVeteranSources = decideTier5Answer({
      field: veteranField,
      answer: 'Yes',
      evidence: 'profile.veteran: Veteran\nresume.veteran: Not a veteran',
      supportQuote: 'Veteran',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(conflictingVeteranSources.reason, 'contradictory_evidence');
    const matchingVeteranSources = decideTier5Answer({
      field: veteranField,
      answer: 'Yes',
      evidence: 'profile.veteran: Veteran\nresume.veteran: Veteran',
      supportQuote: 'Veteran',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(matchingVeteranSources.accepted, true);

    const veteranStatementField: ScannedField = {
      ...eligibilityField,
      label: 'Are you a protected veteran?',
      options: ['I am a protected veteran', 'I am not a protected veteran'],
    };
    const veteranStatement = (answerText: string, value: string) => decideTier5Answer({
      field: veteranStatementField,
      answer: answerText,
      evidence: `profile.veteran: ${value}`,
      supportQuote: value,
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(veteranStatement('I am a protected veteran', 'true').accepted, true);
    assert.equal(veteranStatement('I am not a protected veteran', 'false').accepted, true);
    assert.equal(veteranStatement('I am a protected veteran', 'false').reason, 'contradictory_evidence');
    assert.equal(veteranStatement('I am a protected veteran', 'unknown').reason, 'unsupported_evidence');

    const sponsorshipField: ScannedField = {
      ...eligibilityField, label: 'Will you require sponsorship?',
    };
    const sponsorship = decideTier5Answer({
      field: sponsorshipField, answer: 'Yes', evidence: 'profile.requires_sponsorship: false',
      supportQuote: 'false', confidence: 0.99, stage: 'haiku',
    });
    assert.equal(sponsorship.reason, 'contradictory_evidence');
    const conflictingSponsorshipSources = decideTier5Answer({
      field: sponsorshipField,
      answer: 'No',
      evidence: 'profile.requires_sponsorship: false\nresume.requires_sponsorship: true',
      supportQuote: 'false',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(conflictingSponsorshipSources.reason, 'contradictory_evidence');
    const matchingSponsorshipSources = decideTier5Answer({
      field: sponsorshipField,
      answer: 'No',
      evidence: 'profile.requires_sponsorship: false\nresume.requires_sponsorship: false',
      supportQuote: 'false',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(matchingSponsorshipSources.accepted, true);

    const degreeField: ScannedField = {
      ...eligibilityField, label: 'Do you have a college degree?',
    };
    const degree = (answerText: string, value: string) => decideTier5Answer({
      field: degreeField, answer: answerText,
      evidence: `profile.degree: ${value}`, supportQuote: value,
      confidence: 0.99, stage: 'haiku',
    });
    assert.equal(degree('Yes', 'No degree').reason, 'contradictory_evidence');
    assert.equal(degree('No', 'No degree').accepted, true);
    assert.equal(degree('Yes', 'Degree status unclear').reason, 'unsupported_evidence');
    const conflictingDegreeSources = decideTier5Answer({
      field: degreeField,
      answer: 'Yes',
      evidence: 'profile.education[0].degree: Bachelor of Science\nprofile.degree: No degree',
      supportQuote: 'Bachelor of Science',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(conflictingDegreeSources.reason, 'contradictory_evidence');
    const unrelatedDegreeFacts = decideTier5Answer({
      field: degreeField,
      answer: 'Yes',
      evidence: 'profile.education[0].degree: Bachelor of Science\nprofile.work_authorization: Not authorized to work',
      supportQuote: 'Bachelor of Science',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(unrelatedDegreeFacts.accepted, true);
    const unrelatedVeteranFacts = decideTier5Answer({
      field: veteranField,
      answer: 'Yes',
      evidence: 'profile.veteran: Veteran\nprofile.work_authorization: Not authorized to work',
      supportQuote: 'Veteran',
      confidence: 0.99,
      stage: 'haiku',
    });
    assert.equal(unrelatedVeteranFacts.accepted, true);

    const structuredDegree = (answerText: string, value: string) => decideTier5Answer({
      field: degreeField,
      answer: answerText,
      evidence: `profile.education[0].degree: ${value}`,
      supportQuote: value,
      confidence: 0.99,
      stage: 'haiku',
    });
    for (const value of ['Associate of Arts', 'Bachelor of Science in Computer Science', 'Master of Science', 'Doctor of Philosophy']) {
      assert.equal(structuredDegree('Yes', value).accepted, true, `${value} supports a completed college degree`);
      assert.equal(structuredDegree('No', value).reason, 'contradictory_evidence', `${value} contradicts No`);
    }
    assert.equal(structuredDegree('Yes', 'Currently pursuing a Bachelor of Science').reason, 'unsupported_evidence');
    assert.equal(structuredDegree('No', 'Currently pursuing a Bachelor of Science').reason, 'unsupported_evidence');
  });

  it('classifies concrete past examples as evidence-bound experience questions', () => {
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Tell us about a time you solved a difficult problem' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'What experience do you have with Kubernetes?' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Describe your experience with Kubernetes' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Tell us about your experience using Kubernetes' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Describe a difficult situation you faced' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Tell us how you handled a conflict' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'How have you handled a conflict?' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Have you ever worked with Kubernetes?' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Describe a project where you improved reliability' }), 'experience');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'How would you handle a conflict with a teammate?' }), 'creative');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Suppose a teammate disagrees with you. What would you do?' }), 'creative');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'Why are you interested in this role?' }), 'creative');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'How do you handle conflict?' }), 'factual');
    assert.equal(classifyTier5Question({ ...field, type: 'textarea', options: undefined, label: 'What is your preferred work style?' }), 'factual');
  });

  it('keeps generic past-event answers evidence-bound at the existing 0.70 threshold', () => {
    const actual = { ...field, type: 'textarea' as const, options: undefined, label: 'Tell us how you handled a conflict' };
    const atThreshold = decideTier5Answer({
      field: actual,
      answer: 'I resolved a conflict.',
      evidence: 'profile.conflict_resolution: I resolved a conflict.',
      supportQuote: 'I resolved a conflict.',
      confidence: 0.70,
      stage: 'haiku',
    });
    const belowThreshold = decideTier5Answer({
      field: actual,
      answer: 'I resolved a conflict.',
      evidence: 'profile.conflict_resolution: I resolved a conflict.',
      supportQuote: 'I resolved a conflict.',
      confidence: 0.69,
      stage: 'haiku',
    });
    assert.equal(atThreshold.accepted, true);
    assert.equal(belowThreshold.accepted, false);
    assert.equal(belowThreshold.reason, 'low_confidence');
  });

  it('does not treat an existing quote as support for additional experience claims', () => {
    const experienceField = { ...field, type: 'textarea' as const, options: undefined, label: 'Describe your experience at Acme' };
    const unsupported = decideTier5Answer({
      field: experienceField,
      answer: 'I led Acme global migration.',
      evidence: 'profile.work_experience: Engineer at Acme for five years',
      supportQuote: 'Engineer at Acme for five years',
      confidence: 0.95,
      stage: 'haiku',
    });
    const paraphrase = decideTier5Answer({
      field: experienceField,
      answer: 'I worked as an engineer at Acme for 5 years.',
      evidence: 'profile.work_experience: Engineer at Acme for five years',
      supportQuote: 'Engineer at Acme for five years',
      confidence: 0.95,
      stage: 'haiku',
    });
    assert.equal(unsupported.accepted, false);
    assert.equal(unsupported.reason, 'unsupported_evidence');
    assert.equal(paraphrase.accepted, true);
  });

  it('rejects positive experience claims contradicted by explicit negative evidence', () => {
    const kubernetes = { ...field, type: 'textarea' as const, options: undefined, label: 'Describe your experience with Kubernetes' };
    const decide = (evidence: string, answerText: string) => decideTier5Answer({
      field: kubernetes,
      answer: answerText,
      evidence,
      supportQuote: evidence.split(': ').slice(1).join(': '),
      confidence: 0.95,
      stage: 'haiku',
    });
    assert.equal(decide('profile.work_experience: No Kubernetes experience', 'I have experience with Kubernetes').reason, 'contradictory_evidence');
    assert.equal(decide('profile.work_experience: No Kubernetes experience', 'I have no experience with Kubernetes').accepted, true);
    assert.equal(decide('profile.work_experience: Kubernetes experience', 'I have experience with Kubernetes').accepted, true);
    assert.equal(decide('profile.work_experience: No Kubernetes experience\nprofile.skills: Kubernetes experience', 'I have experience with Kubernetes').reason, 'contradictory_evidence');
    assert.equal(decide('profile.work_experience: Kubernetes experience', 'I am familiar with Kubernetes').reason, 'unsupported_evidence');
    assert.equal(decide('profile.work_experience: Kubernetes experience is unclear', 'I have experience with Kubernetes').reason, 'unsupported_evidence');
    assert.equal(decide('profile.skills: Kubernetes', 'I have experience with Kubernetes').reason, 'unsupported_evidence');
  });

  it('keeps unsupported experience unresolved when required and blank without escalation when optional', async () => {
    const experienceField = { ...field, type: 'textarea' as const, options: undefined, label: 'Describe your experience at Acme' };
    const unsupported = { ...answer('I led Acme global migration.', 0.95), type: 'textarea' as const, label: experienceField.label };
    const args = { evidence: 'profile.work_experience: Engineer at Acme for five years', primarySupportQuote: 'Engineer at Acme for five years' };
    let requiredEscalations = 0;
    const required = await finalizeTier5WithEscalation(experienceField, unsupported, async () => {
      requiredEscalations++;
      return null;
    }, args);
    let optionalEscalations = 0;
    const optional = await finalizeTier5WithEscalation({ ...experienceField, isRequired: false }, { ...unsupported, isRequired: false }, async () => {
      optionalEscalations++;
      return null;
    }, args);
    assert.equal(required, null);
    assert.equal(requiredEscalations, 1);
    assert.equal(optional, null);
    assert.equal(optionalEscalations, 0);
  });

  it('does not gate optional creative answers on confidence, and requires review for required creative answers', async () => {
    const creative = { ...field, type: 'textarea' as const, options: undefined, label: 'Why are you interested in this role?' };
    const lowConfidence = answer('I am interested in contributing to a collaborative team.', 0.2);
    const optional = await finalizeTier5WithEscalation({ ...creative, isRequired: false }, lowConfidence, async () => null);
    assert.equal(optional?.value, lowConfidence.value);
    const inventedHistory = decideTier5Answer({
      field: { ...creative, isRequired: false },
      answer: 'I led a Kubernetes migration at Acme.',
      evidence: 'profile.work_experience: Software engineer with five years of Java experience',
      confidence: 0.95,
      stage: 'haiku',
    });
    assert.equal(inventedHistory.accepted, false);
    assert.equal(inventedHistory.reason, 'unsupported_evidence');
    const evidencedHistory = decideTier5Answer({
      field: { ...creative, isRequired: false },
      answer: 'I led a Kubernetes migration at Acme.',
      evidence: 'profile.work_experience: I led a Kubernetes migration at Acme',
      confidence: 0.95,
      stage: 'haiku',
    });
    assert.equal(evidencedHistory.accepted, true);
    const requiredWithoutReview = await finalizeTier5WithEscalation(creative, lowConfidence, async () => null);
    const requiredWithReview = await finalizeTier5WithEscalation(creative, lowConfidence, async () => null, {
      reviewRequiredCreative: async () => ({
        result: answer('I hope to contribute to meaningful engineering work.', 0.8, 'claude-sonnet-review'), approved: true,
      }),
    });
    const failedReview = await finalizeTier5WithEscalation(creative, lowConfidence, async () => null, {
      reviewRequiredCreative: async () => ({ result: null, approved: false }),
    });
    assert.equal(requiredWithoutReview, null);
    assert.equal(requiredWithReview?.value, 'I hope to contribute to meaningful engineering work.');
    assert.equal(failedReview, null);
    const malformedReview = await finalizeTier5WithEscalation(creative, lowConfidence, async () => null, {
      reviewRequiredCreative: async () => ({ result: answer('Meaningful engineering work is appealing.', 0.8, 'claude-sonnet-review'), approved: true }),
    });
    assert.equal(malformedReview, null);
  });

  it('rejects unsupported creative history from primary and reviewed answers while allowing evidenced history', async () => {
    const creative = { ...field, type: 'textarea' as const, options: undefined, label: 'Why are you interested in this role?' };
    const evidence = 'profile.work_experience: I worked on a Kubernetes migration at Acme';
    const optionalInvented = await finalizeTier5WithEscalation(
      { ...creative, isRequired: false },
      answer('I led a Kubernetes migration at Acme.', 0.9),
      async () => null,
      { evidence },
    );
    assert.equal(optionalInvented, null);

    const supportedAction = await finalizeTier5WithEscalation(
      { ...creative, isRequired: false },
      answer('I worked on a Kubernetes migration at Acme.', 0.2),
      async () => null,
      { evidence },
    );
    assert.equal(supportedAction?.value, 'I worked on a Kubernetes migration at Acme.');

    const primary = answer('I hope to contribute to meaningful engineering work.', 0.2);
    for (const deniedEvidence of [
      evidence,
      'Profile: No, I did not personally lead the Kubernetes migration at Acme.',
      'Profile: I never directly led the Kubernetes migration at Acme.',
      'Profile: I have not actually led the Kubernetes migration at Acme.',
    ]) {
      const reviewed = await finalizeTier5WithEscalation(creative, primary, async () => null, {
        evidence: deniedEvidence,
        reviewRequiredCreative: async () => ({
          result: answer('I led a Kubernetes migration at Acme.', 0.9), approved: true,
        }),
      });
      assert.equal(reviewed, null);
    }

    const evidenced = await finalizeTier5WithEscalation(creative, primary, async () => null, {
      evidence: 'profile.work_experience: I led the Kubernetes migration at Acme.',
      reviewRequiredCreative: async () => ({
        result: answer('I led the Kubernetes migration at Acme.', 0.9), approved: true,
      }),
    });
    assert.equal(evidenced?.value, 'I led the Kubernetes migration at Acme.');
  });

  it('treats hypothetical choice fields as factual and rejects reviewer prose outside complete choices', async () => {
    const outage: ScannedField = {
      ...field,
      type: 'radio',
      label: 'How would you handle a radio outage?',
      options: ['Page the on-call engineer', 'Ignore it'],
    };
    assert.equal(classifyTier5Question(outage), 'factual');
    let escalations = 0;
    let reviews = 0;
    const result = await finalizeTier5WithEscalation(
      outage,
      answer('Page the on-call engineer', 0.2),
      async () => {
        escalations++;
        return { ...answer('Page the on-call engineer', 0.70, 'deepseek/deepseek-r1-0528'), supportQuote: 'Page the on-call engineer' };
      },
      {
        evidence: 'profile.radio_outage_response: Page the on-call engineer',
        primarySupportQuote: 'Page the on-call engineer',
        reviewRequiredCreative: async () => {
          reviews++;
          return { result: answer('I would page the on-call engineer.', 0.99), approved: true };
        },
      },
    );
    assert.equal(result?.value, 'Page the on-call engineer');
    assert.equal(escalations, 1);
    assert.equal(reviews, 0);
  });

  it('rejects a creative reviewer result that does not match a complete choice list', async () => {
    const choiceField: ScannedField = {
      ...field,
      type: 'radio',
      label: 'How would you handle a radio outage?',
      options: ['Page the on-call engineer', 'Ignore it'],
    };
    let reviews = 0;
    const result = await finalizeTier5WithEscalation(
      choiceField,
      answer('Page the on-call engineer', 0.2),
      async () => null,
      {
        reviewRequiredCreative: async () => {
          reviews++;
          return { result: answer('I would page the on-call engineer.', 0.99), approved: true };
        },
      },
    );
    assert.equal(result, null);
    assert.equal(reviews, 0);
  });

  it('allows evidence-supported answers outside a partial choice sample', async () => {
    const incomplete = { ...field, options: ['Other'], optionsComplete: false };
    const result = await finalizeTier5WithEscalation(incomplete, answer('Authorized', 0.80), async () => null, {
      evidence: 'profile.work_authorization: Authorized',
      primarySupportQuote: 'Authorized',
    });
    assert.equal(result?.value, 'Authorized');
  });

  it('decision carries evidence, stage, and malformed output rejection', () => {
    const decision = decideTier5Answer({ field, answer: '', evidence: 'Profile fact', confidence: null, stage: 'haiku' });
    assert.equal(decision.accepted, false);
    assert.equal(decision.reason, 'empty_answer');
    assert.equal(decision.evidence, 'Profile fact');
    assert.equal(decision.supportQuote, '');
    assert.equal(decision.stage, 'haiku');
  });
});

describe('DeepSeek OpenRouter adapter', () => {
  it('uses the configured R1 model and JSON response mode, and rejects missing confidence', async () => {
    const originalFetch = globalThis.fetch;
    let sent: any;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"answer":"Authorized"}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const synthesizer = new LLMSynthesizer({ openRouterApiKey: 'test-key' });
      const response = await synthesizer.synthesizeDeepSeekAnswer(
        field,
        { applywizzId: 'test', clientName: 'Test' } as any,
        '',
        { title: 'Engineer', company: 'Example' }
      );
      assert.equal(sent.model, 'deepseek/deepseek-r1-0528');
      assert.deepEqual(sent.response_format, { type: 'json_object' });
      assert.equal(response.result.source, 'unresolved');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
