import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMSynthesizer, parseBatchAnswerResponse } from '../src/resolver/llmSynthesizer.js';

test('Tier 5 requests structured answers and leaves missing answers blank', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.output_config.format.schema.required, ['answers']);
    assert.equal(body.output_config.format.type, 'json_schema');
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"answers":["Yes",""]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 });
  };
  try {
    const synthesizer = new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5' });
    const result = await synthesizer.synthesizeBatchAnswers([
      { label: 'Are you available?', type: 'radio' },
      { label: 'Explain your experience', type: 'textarea' },
    ], '', '');
    assert.deepEqual(result.answers, ['Yes', '']);
    assert.equal(parseBatchAnswerResponse('', 2), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
