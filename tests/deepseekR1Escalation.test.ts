import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ResolvedField, ScannedField } from '../src/types/index.js';
import { finalizeTier5WithEscalation } from '../src/resolver/tier5LLM.js';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';

const field: ScannedField = {
  fieldId: 'q1',
  name: 'q1',
  type: 'select',
  label: 'Work authorization',
  isRequired: true,
  options: ['Authorized', 'Not authorized'],
};

function answer(value: string, confidence: number, model = 'claude-haiku-5-5'): ResolvedField {
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
    tier5Provenance: { fieldKey: 'key', winningModel: model, attempts: [] },
  };
}

describe('shared Tier 5 escalation finalization', () => {
  it('accepts primary confidence at 0.80 without escalating', async () => {
    let escalations = 0;
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.8), async () => {
      escalations++;
      return answer('Authorized', 0.9, 'deepseek/deepseek-r1-0528');
    });
    assert.equal(result?.value, 'Authorized');
    assert.equal(result?.confidence, 0.8);
    assert.equal(escalations, 0);
  });

  it('escalates primary confidence 0.79 and accepts DeepSeek at 0.65', async () => {
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.79), async () =>
      answer('Authorized', 0.65, 'deepseek/deepseek-r1-0528')
    );
    assert.equal(result?.value, 'Authorized');
    assert.equal(result?.confidence, 0.65);
    assert.equal(result?.tier5Provenance?.winningModel, 'deepseek/deepseek-r1-0528');
  });

  it('escalates an invalid exact choice', async () => {
    let escalations = 0;
    const result = await finalizeTier5WithEscalation(field, answer('Maybe', 0.95), async () => {
      escalations++;
      return answer('Authorized', 0.8, 'deepseek/deepseek-r1-0528');
    });
    assert.equal(escalations, 1);
    assert.equal(result?.value, 'Authorized');
  });

  it('escalates an unresolved primary answer', async () => {
    const result = await finalizeTier5WithEscalation(field, null, async () =>
      answer('Authorized', 0.8, 'deepseek/deepseek-r1-0528')
    );
    assert.equal(result?.value, 'Authorized');
    assert.equal(result?.tier5Provenance?.attempts[0].status, 'rejected');
  });

  it('leaves the field unresolved when DeepSeek fails; it does not retain a 0.79 primary answer', async () => {
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.79), async () => null);
    assert.equal(result, null);
  });

  it('leaves the field unresolved when DeepSeek confidence is below 0.65', async () => {
    const result = await finalizeTier5WithEscalation(field, answer('Authorized', 0.79), async () =>
      answer('Authorized', 0.64, 'deepseek/deepseek-r1-0528')
    );
    assert.equal(result, null);
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
