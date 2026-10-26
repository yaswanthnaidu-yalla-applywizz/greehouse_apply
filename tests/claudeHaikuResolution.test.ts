import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import type { ScannedField, ApplyWizzCandidateProfile } from '../src/types/index.js';

describe('Claude Haiku 5.5 LLM Synthesis', () => {
  const originalFetch = globalThis.fetch;
  let interceptedRequests: { url: string; options: any }[] = [];

  before(() => {
    // Mock fetch to test Anthropic API interaction
    globalThis.fetch = async (url: any, options: any) => {
      const urlStr = String(url);
      if (!urlStr.includes('api.anthropic.com')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      interceptedRequests.push({ url: urlStr, options });
      const body = JSON.parse(options.body);

      // Verify no temperature is sent for Haiku 5.5
      if (body.temperature !== undefined) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'temperature is not supported for claude-haiku-5-5',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Check for rate limit simulation
      if (body.messages?.[0]?.content?.includes('SIMULATE_RATE_LIMIT')) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Mock batch array response (system contains prompt instructions)
      if (
        body.system?.includes('JSON array of direct answer strings') ||
        body.messages?.[0]?.content?.includes('JSON array of direct answer strings')
      ) {
        return new Response(
          JSON.stringify({
            id: 'msg_test123',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'text', text: '["Yes", "5 years"]' }],
            usage: { input_tokens: 150, output_tokens: 25 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Default mock single answer response
      return new Response(
        JSON.stringify({
          id: 'msg_test123',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [
            {
              type: 'text',
              text: '{"answer":"Authorized to work in US","confidence":0.95}',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('initializes LLMSynthesizer with provider anthropic and model claude-haiku-5-5', () => {
    const synth = new LLMSynthesizer({
      provider: 'anthropic' as any,
      apiKey: 'sk-ant-test-key-12345',
      workspaceId: 'wrk_test_workspace_999',
    } as any);

    const diag = synth.getProviderDiagnostics();
    assert.strictEqual(diag.provider, 'anthropic');
    assert.strictEqual(diag.model, 'claude-haiku-5-5');
  });

  it('sends x-api-key, anthropic-version, and anthropic-workspace-id headers without temperature', async () => {
    interceptedRequests = [];

    const synth = new LLMSynthesizer({
      provider: 'anthropic' as any,
      apiKey: 'sk-ant-test-key-12345',
      workspaceId: 'wrk_test_workspace_999',
    } as any);

    const testField: ScannedField = {
      fieldId: 'work_auth',
      name: 'work_auth',
      type: 'textarea',
      label: 'Please describe your work authorization status',
      isRequired: true,
    };

    const profile: ApplyWizzCandidateProfile = {
      applywizz_id: 'AWL-TEST-1',
      client_name: 'John Doe',
      email: 'john@example.com',
      workAuthorization: 'US Citizen',
      requiresSponsorship: 'No',
    } as any;

    const res = await synth.synthesizeAnswer(testField, profile, '', {
      title: 'Senior Developer',
      company: 'Tech Corp',
    });

    assert.strictEqual(res.source, 'ai');
    assert.strictEqual(res.value, 'Authorized to work in US');

    assert.strictEqual(interceptedRequests.length, 1);
    const req = interceptedRequests[0];
    assert.strictEqual(req.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(req.options.headers['x-api-key'], 'sk-ant-test-key-12345');
    assert.strictEqual(req.options.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(req.options.headers['anthropic-workspace-id'], 'wrk_test_workspace_999');

    const body = JSON.parse(req.options.body);
    assert.strictEqual(body.model, 'claude-haiku-5-5');
    assert.strictEqual(body.temperature, undefined, 'temperature must NOT be included for Haiku 5.5');
  });

  it('synthesizes batch answers using Claude Haiku 5.5 and tracks token usage', async () => {
    interceptedRequests = [];

    const synth = new LLMSynthesizer({
      provider: 'anthropic' as any,
      apiKey: 'sk-ant-test-key-12345',
      workspaceId: 'wrk_test_workspace_999',
    } as any);

    const questions = [
      { label: 'Are you authorized to work in the US?', type: 'radio', options: ['Yes', 'No'] },
      { label: 'Years of Experience?', type: 'text' },
    ];

    const result = await synth.synthesizeBatchAnswers(questions as any, '', 'Full Stack Engineer');

    assert.deepStrictEqual(result.answers, ['Yes', '5 years']);
    assert.ok(result.usage);
    assert.strictEqual(result.usage.promptTokens, 150);
    assert.strictEqual(result.usage.completionTokens, 25);
    assert.strictEqual(result.usage.model, 'claude-haiku-5-5');
  });

  it('fails fast on 429 rate limit leaving question unresolved without falling back', async () => {
    interceptedRequests = [];

    const synth = new LLMSynthesizer({
      provider: 'anthropic' as any,
      apiKey: 'sk-ant-test-key-12345',
      workspaceId: 'wrk_test_workspace_999',
    } as any);

    const testField: ScannedField = {
      fieldId: 'q_fail',
      name: 'q_fail',
      type: 'textarea',
      label: 'SIMULATE_RATE_LIMIT please',
      isRequired: true,
    };

    const profile: ApplyWizzCandidateProfile = {
      applywizz_id: 'AWL-TEST-1',
      client_name: 'John Doe',
      email: 'john@example.com',
    } as any;

    const res = await synth.synthesizeAnswer(testField, profile);

    // Leaves question unresolved
    assert.strictEqual(res.source, 'unresolved');
    // Exactly 1 request was attempted to Anthropic - no secondary provider fallback
    assert.strictEqual(interceptedRequests.length, 1);
  });
});
