import test from 'node:test';
import assert from 'node:assert/strict';
import { callGemini } from '../src/resolver/geminiProvider.js';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import type { BatchQuestion } from '../src/types/index.js';

test('Task 6: Native Google Gemini Provider Direct Call', async () => {
  const result = await callGemini({
    prompt: 'Return a JSON object with answers array for question: "Are you authorized to work in the United States?" Candidate data: Authorized to work in the US.',
    systemMessage: 'You are an automated job application assistant. Return JSON object with answers array: {"answers":[{"answer":"Yes","confidence":0.95,"supportQuote":"Authorized to work in the US"}]}',
    modelName: 'gemini-3.5-flash-lite',
  });

  assert.ok(result.text, 'Gemini should return a text response');
  assert.ok(result.usage, 'Gemini should return token usage metadata');
  assert.ok(result.usage.promptTokens > 0, 'Prompt tokens should be > 0');

  const parsed = JSON.parse(result.text);
  assert.ok(Array.isArray(parsed.answers), 'Parsed response should contain an answers array');
  assert.equal(parsed.answers[0].answer, 'Yes');
});

test('Task 6: LLMSynthesizer with Gemini Provider Batch Synthesis', async () => {
  const synthesizer = new LLMSynthesizer({
    provider: 'gemini',
    geminiModel: 'gemini-3.5-flash-lite',
  });

  const diagnostics = synthesizer.getProviderDiagnostics();
  assert.equal(diagnostics.provider, 'gemini');
  assert.equal(diagnostics.model, 'gemini-3.5-flash-lite');

  const questions: BatchQuestion[] = [
    {
      label: 'Are you legally authorized to work in the United States?',
      type: 'select',
      options: ['Yes', 'No'],
      candidateEvidence: 'Profile: Authorized to work in the US. No sponsorship required.',
    },
    {
      label: 'Will you now or in the future require sponsorship?',
      type: 'select',
      options: ['Yes', 'No'],
      candidateEvidence: 'Profile: Does not require sponsorship.',
    },
  ];

  const batchResult = await synthesizer.synthesizeBatchAnswers(
    questions,
    'Resume: Senior Software Engineer with 5 years experience.',
    'Job: Senior Backend Engineer at TechCorp'
  );

  assert.ok(Array.isArray(batchResult.answers), 'Should return answers array');
  assert.equal(batchResult.answers.length, 2, 'Should return 2 answers');
  assert.equal(batchResult.answers[0], 'Yes', 'First question should resolve to Yes');
  assert.equal(batchResult.answers[1], 'No', 'Second question should resolve to No');
});

test('Task 6: LLMSynthesizer with Gemini Bundled Batch Prompt Runner', async () => {
  const synthesizer = new LLMSynthesizer({
    provider: 'gemini',
    geminiModel: 'gemini-3.5-flash-lite',
  });

  const prompts = [
    {
      customId: 'item_1',
      prompt: 'Question: What is your preferred work style?\nChoices: Remote | Onsite | Hybrid\nCandidate evidence: Preferred working style is Remote.',
      system: 'Resolve question to one choice.',
    },
    {
      customId: 'item_2',
      prompt: 'Question: Do you have a valid driver\'s license?\nChoices: Yes | No\nCandidate evidence: Holds a valid standard driver license.',
      system: 'Resolve question to one choice.',
    },
    {
      customId: 'item_3',
      prompt: 'Question: Are you open to relocation?\nChoices: Yes | No\nCandidate evidence: Open to relocate anywhere.',
      system: 'Resolve question to one choice.',
    },
  ];

  const result = await synthesizer.runGeminiPromptBatch('test-bundled', prompts);
  assert.equal(result.status, 'ended');
  assert.equal(result.failedIds.size, 0, 'No prompts should fail');
  assert.ok(result.responses.has('item_1'), 'Should have item_1 response');
  assert.ok(result.responses.has('item_2'), 'Should have item_2 response');
  assert.ok(result.responses.has('item_3'), 'Should have item_3 response');

  const p1 = JSON.parse(result.responses.get('item_1')!);
  assert.equal(p1.answers[0].answer, 'Remote');
  const p2 = JSON.parse(result.responses.get('item_2')!);
  assert.equal(p2.answers[0].answer, 'Yes');
  const p3 = JSON.parse(result.responses.get('item_3')!);
  assert.equal(p3.answers[0].answer, 'Yes');
});
