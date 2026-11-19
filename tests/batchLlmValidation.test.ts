/**
 * Batch Tier-5 post-validation: choice fields must match options exactly (fail-closed).
 */

import { LLMSynthesizer, buildBatchPrompt, buildSinglePrompt, decideTier5Answer, matchExactOption, parseBatchAnswerItems, parseLlmResponse } from '../src/resolver/llmSynthesizer.js';
import { config } from '../src/config/env.js';
import type { ScannedField } from '../src/types/index.js';

async function runTests() {
  console.log('🧪 Batch LLM validation tests\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, name: string) {
    total++;
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
    }
  }

  assert(matchExactOption('Yes', ['Yes', 'No']) === 'Yes', 'matchExactOption accepts Yes');
  assert(matchExactOption('maybe', ['Yes', 'No']) === null, 'matchExactOption rejects non-option');
  assert((config as any).LLM_TIMEOUT_MS === 30000, 'config.LLM_TIMEOUT_MS defaults to 30000');
  const factualField: ScannedField = {
    fieldId: 'work-auth', name: 'work_authorization', type: 'radio',
    label: 'Are you authorized to work in the US?', isRequired: true, options: ['Yes', 'No'],
  };
  const factualEvidence = 'work_authorization: Authorized to work in the United States';
  const factualDecision = (confidence: number) => decideTier5Answer({
    field: factualField, answer: 'Yes', evidence: factualEvidence,
    supportQuote: 'Authorized to work in the United States', confidence, stage: 'sonnet', reviewed: true,
  });
  assert(!factualDecision(0.69).accepted && factualDecision(0.69).reason === 'low_confidence',
    'supported factual answer at 0.69 remains unresolved');
  assert(factualDecision(0.70).accepted, 'supported factual answer at the 0.70 threshold is accepted');
  const citedBatch = parseBatchAnswerItems('{"answers":[{"answer":"Yes","confidence":0.9,"supportQuote":"Authorized to work"}]}', 1);
  assert(citedBatch?.[0]?.supportQuote === 'Authorized to work', 'batch parser preserves a structured support quote');
  assert(parseLlmResponse('{"answer":"Yes","confidence":0.9,"supportQuote":"Authorized to work"}').supportQuote === 'Authorized to work', 'single parser preserves a structured support quote');

  const creativeField: ScannedField = {
    fieldId: 'motivation', name: 'motivation', type: 'textarea',
    label: 'Why are you interested in this role? Answer in 25 words.', isRequired: false,
  };
  const creativeProfile = { applywizzId: 'TEST-1', clientName: 'Test User' } as any;
  const singleCreativePrompt = buildSinglePrompt(creativeField, creativeProfile, '', {
    title: 'Engineer', company: 'Acme',
  });
  const batchCreativePrompt = buildBatchPrompt([{
    label: creativeField.label, type: creativeField.type,
    candidateEvidence: '(No directly relevant candidate evidence found.)',
  }], 'Role: Engineer', creativeProfile);
  assert(singleCreativePrompt.includes('Follow any explicit length instruction'), 'single creative prompt follows explicit length instructions');
  assert(singleCreativePrompt.includes('without claiming a past event'), 'single creative prompt forbids invented experience');
  assert(batchCreativePrompt.includes('Natural first person'), 'batch creative prompt requests first-person answers');

  const originalFetch = globalThis.fetch;
  const creativeAnswer = 'I am interested in this role because it would let me contribute thoughtfully while continuing to learn.';
  const fallbackProfile = { applywizz_id: 'TEST-1', client_name: 'Test User' } as any;
  const requiredCreativeField = { ...creativeField, isRequired: true };
  const fallback = new LLMSynthesizer({ provider: 'anthropic', apiKey: '', openRouterApiKey: 'offline-test' });
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: creativeAnswer }) } }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const creativeFallback = await fallback.synthesizeDeepSeekAnswer(requiredCreativeField, fallbackProfile);
    assert(creativeFallback.result.source === 'ai' && creativeFallback.result.value === creativeAnswer,
      'DeepSeek fallback allows missing confidence for a creative answer');
    const creativeDecision = (reviewed: boolean) => decideTier5Answer({
      field: requiredCreativeField, answer: creativeAnswer, evidence: '', confidence: null,
      stage: 'deepseek-r1', reviewed,
    });
    assert(!creativeDecision(false).accepted && creativeDecision(false).reason === 'review_required',
      'required creative answer still needs review');
    assert(creativeDecision(true).accepted, 'reviewed required creative answer is accepted without confidence');

    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 'Yes' }) } }], usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const factualFallback = await fallback.synthesizeDeepSeekAnswer({
      fieldId: 'work-auth', name: 'authorized', type: 'radio',
      label: 'Are you authorized to work in the US?', isRequired: true, options: ['Yes', 'No'],
    }, fallbackProfile);
    assert(factualFallback.result.source === 'unresolved', 'factual fallback still requires confidence');

    assert(!decideTier5Answer({
      field: requiredCreativeField, answer: 'I led the Apollo migration and doubled revenue.', evidence: '',
      confidence: null, stage: 'deepseek-r1', reviewed: true,
    }).accepted, 'unsupported past claim remains unresolved');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const synthesizer = new LLMSynthesizer({ provider: 'anthropic', apiKey: '' });
  const profile = {
    applywizz_id: 'TEST-1',
    client_name: 'Test User',
    email: 'test@example.com',
  } as any;

  const radioField: ScannedField = {
    fieldId: 'auth',
    name: 'authorized',
    type: 'radio',
    label: 'Are you authorized to work in the US?',
    isRequired: true,
    options: ['Yes', 'No'],
  };

  const good = synthesizer.finalizeRawAnswer('Yes', radioField, profile, {
    title: 'Engineer',
    company: 'Acme',
  }, { defaultConfidenceIfMissing: 0.85 });
  assert(good.source === 'ai' && good.value === 'Yes', 'finalizeRawAnswer accepts exact radio option');

  const bad = synthesizer.finalizeRawAnswer('Definitely yes', radioField, profile, {
    title: 'Engineer',
    company: 'Acme',
  }, { defaultConfidenceIfMissing: 0.85 });
  assert(bad.source === 'unresolved', 'finalizeRawAnswer fail-closed on non-exact option');

  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
