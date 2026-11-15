import test from 'node:test';
import assert from 'node:assert/strict';
import { callOllama } from '../src/resolver/ollamaProvider.js';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import type { BatchQuestion } from '../src/types/index.js';

test('Ollama Provider Direct Call (llama3.1:latest as Haiku)', async () => {
  const result = await callOllama({
    prompt: 'Return JSON only: {"answers":[{"answer":"Yes","confidence":0.95,"supportQuote":"Authorized in US"}]}',
    systemMessage: 'You are an automated job application assistant.',
    modelName: 'llama3.1:latest',
  });

  assert.ok(result.text, 'Ollama should return text');
  assert.ok(result.usage, 'Ollama should return token usage metadata');
  const parsed = JSON.parse(result.text);
  assert.ok(Array.isArray(parsed.answers), 'Response should have answers array');
  assert.equal(parsed.answers[0].answer, 'Yes');
});

test('LLMSynthesizer with Ollama Batch Synthesis', async () => {
  const synthesizer = new LLMSynthesizer({
    provider: 'ollama',
    ollamaModel: 'llama3.1:latest',
    ollamaSonnetModel: 'qwen3:latest',
  });

  const diagnostics = synthesizer.getProviderDiagnostics();
  assert.equal(diagnostics.provider, 'ollama');
  assert.equal(diagnostics.model, 'llama3.1:latest');

  const questions: BatchQuestion[] = [
    {
      label: 'Are you legally authorized to work in the United States?',
      type: 'select',
      options: ['Yes', 'No'],
      candidateEvidence: 'Profile: Authorized to work in the US. No sponsorship required.',
    },
  ];

  const batchResult = await synthesizer.synthesizeBatchAnswers(
    questions,
    'Resume: Senior Software Engineer with 5 years experience.',
    'Job: Senior Backend Engineer at TechCorp'
  );

  assert.ok(Array.isArray(batchResult.answers), 'Should return answers array');
  assert.equal(batchResult.answers.length, 1);
  assert.equal(batchResult.answers[0], 'Yes');
});
