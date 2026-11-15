import assert from 'node:assert/strict';
import test from 'node:test';
import { IngestTier5BatchPendingError, IngestTier5ReconciliationRequiredError, preserveNewerAuthoritativeAnswers, resolveIngestTier5, type IngestTier5Work } from '../src/resolver/ingestTier5Coordinator.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import type { ResolvedField } from '../src/types/index.js';
import { createIngestTier5Stages } from '../src/resolver/tier5LLM.js';
import { LLMSynthesizer } from '../src/resolver/llmSynthesizer.js';
import { AnthropicBatchPollingAbortedError, executeAnthropicBatchWithRetry, type AnthropicBatchProvider, type AnthropicBatchRequest, type BatchRunState, type BatchRunStateStore } from '../src/resolver/anthropicMessageBatch.js';
import { applicationNeedsOperatorReview, applicationShouldBeFilteredOut } from '../src/resolver/needsReview.js';

function work(candidateId: string, jobUrl: string, fieldId: string, required = true): IngestTier5Work {
  const field = { fieldId, name: fieldId, type: 'text', label: 'Repeated question', isRequired: required } as any;
  const original: ResolvedField = { ...field, value: '', source: 'unresolved', resolvedByTier: null, confidence: 0, isRequired: required };
  return { candidateId, jobUrl, fieldKey: `${candidateId}|${jobUrl}|${fieldId}`, field, original, profile: {} as any, resumeText: '', jobTitle: '', companyName: '', questionFingerprint: generateFingerprint(field.label, field.type) };
}

function answer(fieldKey: string, value: string): { fieldKey: string; answer: ResolvedField } {
  return { fieldKey, answer: { fieldId: '', name: '', type: 'text', label: '', value, source: 'ai', resolvedByTier: 5, confidence: 0.9 } };
}

test('maps out-of-order stage results by stable candidate/job/field key and escalates only required misses', async () => {
  const items = [work('candidate-a', 'job-1', 'field-1'), work('candidate-b', 'job-2', 'field-1'), work('candidate-a', 'job-3', 'field-2', false)];
  const haikuCalls: string[][] = [];
  const sonnetCalls: string[][] = [];
  const result = await resolveIngestTier5(items, {
    async haiku(batch) {
      haikuCalls.push(batch.map((item) => item.fieldKey));
      return [answer(items[2].fieldKey, 'optional answer'), answer(items[0].fieldKey, 'first answer')];
    },
    async sonnet(batch) {
      sonnetCalls.push(batch.map((item) => item.fieldKey));
      return [answer(items[1].fieldKey, 'second answer')];
    },
  });
  assert.equal(result.get(items[0].fieldKey)?.value, 'first answer');
  assert.equal(result.get(items[1].fieldKey)?.value, 'second answer');
  assert.equal(result.get(items[2].fieldKey)?.value, 'optional answer');
  assert.deepEqual(sonnetCalls, [[items[1].fieldKey]]);
  assert.equal(haikuCalls[0].length, 3);
});

test('keeps partial failures unresolved and rejects duplicate or unexpected provider IDs', async () => {
  const items = [work('candidate-a', 'job-1', 'field-1'), work('candidate-b', 'job-2', 'field-1')];
  const result = await resolveIngestTier5(items, {
    async haiku() { return [answer(items[0].fieldKey, 'supported')]; },
    async sonnet() { return []; },
  });
  assert.equal(result.get(items[0].fieldKey)?.value, 'supported');
  assert.equal(result.has(items[1].fieldKey), false);
  await assert.rejects(resolveIngestTier5(items, {
    async haiku() { return [answer(items[0].fieldKey, 'one'), answer(items[0].fieldKey, 'two')]; },
    async sonnet() { return []; },
  }), /duplicate Tier 5 result/i);
  const conflict = { ...items[0], questionFingerprint: 'different-fingerprint' };
  await assert.rejects(resolveIngestTier5([items[0], conflict], {
    async haiku() { return []; }, async sonnet() { return []; },
  }), /conflicting ingest Tier 5 field key/i);
});

test('evaluation callback receives rejected and omitted stage decisions without affecting acceptance', async () => {
  const items = [work('candidate-a', 'job-1', 'field-1'), work('candidate-b', 'job-2', 'field-2')];
  const decisions: Array<{ fieldKey: string; stage: string; outcome: string; reason: string; supportQuote?: string; evidenceReference?: string }> = [];
  const result = await resolveIngestTier5(items, {
    async haiku() {
      return [{ fieldKey: items[0].fieldKey, answer: null, evaluation: {
        fieldKey: items[0].fieldKey, stage: 'haiku', outcome: 'rejected', reason: 'contradictory_evidence',
        supportQuote: 'private quote', evidenceReference: 'sha256:0123456789abcdef',
      } }];
    },
    async sonnet() { return []; },
  }, (decision) => decisions.push(decision));

  assert.equal(result.size, 0);
  assert.deepEqual(decisions.map(({ fieldKey, stage, outcome, reason }) => ({ fieldKey, stage, outcome, reason })), [
    { fieldKey: items[0].fieldKey, stage: 'haiku', outcome: 'rejected', reason: 'contradictory_evidence' },
    { fieldKey: items[1].fieldKey, stage: 'haiku', outcome: 'missing', reason: 'stage_result_omitted' },
    { fieldKey: items[0].fieldKey, stage: 'sonnet', outcome: 'missing', reason: 'stage_result_omitted' },
    { fieldKey: items[1].fieldKey, stage: 'sonnet', outcome: 'missing', reason: 'stage_result_omitted' },
  ]);
  assert.equal(decisions[0].supportQuote, 'private quote');
  assert.equal(decisions[0].evidenceReference, 'sha256:0123456789abcdef');
  assert.equal(decisions[1].supportQuote, undefined);
});

test('evaluation callback labels thrown provider failures unavailable at each stage', async () => {
  const item = work('candidate-a', 'job-1', 'field-1');
  const decisions: Array<{ fieldKey: string; stage: string; outcome: string; reason: string }> = [];
  const result = await resolveIngestTier5([item], {
    async haiku() { throw new Error('transport detail'); },
    async sonnet() { throw new Error('provider detail'); },
  }, (decision) => decisions.push(decision));

  assert.equal(result.size, 0);
  assert.deepEqual(decisions, [
    { fieldKey: item.fieldKey, stage: 'haiku', outcome: 'unavailable', reason: 'provider_exception' },
    { fieldKey: item.fieldKey, stage: 'sonnet', outcome: 'unavailable', reason: 'provider_exception' },
  ]);
});

test('evaluation callback preserves abort and reconciliation exceptions', async () => {
  const item = work('candidate-a', 'job-1', 'field-1');
  const decisions: unknown[] = [];
  await assert.rejects(resolveIngestTier5([item], {
    async haiku() { throw new AnthropicBatchPollingAbortedError(); },
    async sonnet() { return []; },
  }, (decision) => decisions.push(decision)), AnthropicBatchPollingAbortedError);
  await assert.rejects(resolveIngestTier5([item], {
    async haiku() { throw new IngestTier5ReconciliationRequiredError(); },
    async sonnet() { return []; },
  }, (decision) => decisions.push(decision)), IngestTier5ReconciliationRequiredError);
  assert.deepEqual(decisions, []);
});

test('propagates pending Haiku batches and blocks application finalization', async () => {
  const item = work('candidate-a', 'job-1', 'field-1');
  let sonnetCalled = false;
  await assert.rejects(resolveIngestTier5([item], {
    async haiku() { return { results: [], pending: true, batchIds: ['haiku-known-id'] }; },
    async sonnet() { sonnetCalled = true; return []; },
  }), (error) => error instanceof IngestTier5BatchPendingError && error.stage === 'haiku' && error.batchIds[0] === 'haiku-known-id');
  assert.equal(sonnetCalled, false);
});

test('propagates pending Sonnet creative review without returning Haiku draft as final', async () => {
  const item = work('candidate-a', 'job-1', 'field-1');
  const creative = { ...item, field: { ...item.field, label: 'Why do you want to join our team?' } };
  let sonnetCalled = false;
  await assert.rejects(resolveIngestTier5([creative], {
    async haiku() { return [answer(creative.fieldKey, 'I solved a difficult problem by collaborating.')]; },
    async sonnet() { sonnetCalled = true; return { results: [], pending: true, batchIds: ['sonnet-known-id'] }; },
  }), (error) => error instanceof IngestTier5BatchPendingError && error.stage === 'sonnet' && error.batchIds[0] === 'sonnet-known-id');
  assert.equal(sonnetCalled, true);
});

test('includes available role and company context in the Sonnet review prompt', async () => {
  const requests: AnthropicBatchRequest[][] = [];
  const provider: AnthropicBatchProvider = {
    async create(batchRequests) { requests.push(batchRequests); return { id: 'sonnet-context', processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results() {
      const request = requests[0][0];
      return JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: { content: [{
        type: 'text', text: JSON.stringify({ answers: [{ answer: 'Python', confidence: 0.95, supportQuote: 'Python' }] }),
      }] } } });
    },
  };
  const store: BatchRunStateStore = {
    async get() { return undefined; },
    async put() {},
    async claim() { return undefined; },
    async claimEventEmission() { return true; },
  };
  const field = { fieldId: 'languages', name: 'languages', type: 'text', label: 'Which programming language have you used?', isRequired: true } as any;
  const item = {
    ...work('candidate-sonnet-context', 'job-sonnet-context', field.fieldId),
    field,
    profile: { applywizz_id: 'candidate-sonnet-context', client_name: 'Candidate', resume_facts: {} } as any,
    jobTitle: 'Platform Engineer',
    companyName: 'Example Systems',
    jobPostingFacts: { location: 'Toronto, Canada', locations: ['Toronto, Canada'], raw: { workMode: 'Hybrid', internal: { ignored: true } } },
  };
  const stages = createIngestTier5Stages('sonnet-context', new LLMSynthesizer({
    apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: store,
  }));
  await stages.sonnet([item], new Map([[item.fieldKey, answer(item.fieldKey, 'Python').answer]]));
  const prompt = String((requests[0][0].params.messages as Array<{ content: string }>)[0].content);
  assert.match(prompt, /Role: Platform Engineer/);
  assert.match(prompt, /Company: Example Systems/);
  assert.match(prompt, /Location: Toronto, Canada/);
  assert.match(prompt, /workMode: Hybrid/);
  assert.doesNotMatch(prompt, /Candidate evidence:[\s\S]*Location: Toronto/);
  assert.match(prompt, /Which programming language have you used\?/);
});

test('optional creative Haiku validates length and first person without confidence gating', async () => {
  const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'In no more than 5 words, why do you want to join our team?', isRequired: false } as any;
  const makeStages = async (answerText: string, confidence: number) => {
    const requests: AnthropicBatchRequest[][] = [];
    const provider: AnthropicBatchProvider = {
      async create(batchRequests) { requests.push(batchRequests); return { id: `haiku-${requests.length}`, processing_status: 'in_progress' }; },
      async retrieve(id) { return { id, processing_status: 'ended' }; },
      async results() {
        const request = requests.at(-1)![0];
        return JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: { content: [{
          type: 'text', text: JSON.stringify({ answers: [{ answer: answerText, confidence, supportQuote: '' }] }),
        }] } } });
      },
    };
    const store: BatchRunStateStore = { async get() { return undefined; }, async put() {}, async claim() { return undefined; }, async claimEventEmission() { return true; } };
    const item = { ...work('candidate-optional-creative', 'job-optional-creative', field.fieldId, false), field };
    return { item, outcome: await createIngestTier5Stages('optional-creative', new LLMSynthesizer({
      apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: store,
    })).haiku([item]) };
  };
  assert.equal((await makeStages('I want to contribute meaningfully today', 0.2)).outcome[0].answer, null, 'overlong answer is blanked despite no confidence threshold');
  assert.equal((await makeStages('Contribute meaningfully', 0.9)).outcome[0].answer, null, 'third-person answer is blanked');
  const accepted = await makeStages('I enjoy solving problems', 0.1);
  assert.equal(accepted.outcome[0].answer?.value, 'I enjoy solving problems', 'valid optional creative answer is not confidence-gated');
});

test('includes only available scanned job facts in the Haiku prompt', async () => {
  const requests: AnthropicBatchRequest[][] = [];
  const provider: AnthropicBatchProvider = {
    async create(batchRequests) { requests.push(batchRequests); return { id: 'haiku-context', processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results() {
      const request = requests[0][0];
      return JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: { content: [{
        type: 'text', text: JSON.stringify({ answers: [{ answer: 'Python', confidence: 0.95, supportQuote: 'Python' }] }),
      }] } } });
    },
  };
  const store: BatchRunStateStore = { async get() { return undefined; }, async put() {}, async claim() { return undefined; }, async claimEventEmission() { return true; } };
  const field = { fieldId: 'languages', name: 'languages', type: 'text', label: 'Which programming language have you used?', isRequired: true } as any;
  const item = { ...work('candidate-haiku-context', 'job-haiku-context', field.fieldId), field, profile: { applywizz_id: 'candidate-haiku-context', client_name: 'Candidate', resume_facts: {} } as any, jobPostingFacts: { location: 'Montreal, QC' } };
  await createIngestTier5Stages('haiku-context', new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: store })).haiku([item]);
  const prompt = String((requests[0][0].params.messages as Array<{ content: string }>)[0].content);
  assert.match(prompt, /Job posting facts:[\s\S]*Location: Montreal, QC/);
  assert.match(prompt, /Candidate evidence:/);
});

test('Sonnet creative review receives explicit length/policy guidance and rejects overlong answers', async () => {
  const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'In no more than 5 words, why do you want to join our team?', isRequired: true } as any;
  const item = {
    ...work('candidate-sonnet-length', 'job-sonnet-length', field.fieldId), field,
    profile: { applywizz_id: 'candidate-sonnet-length', client_name: 'Candidate', resume_facts: {} } as any,
    jobTitle: 'Platform Engineer', companyName: 'Example Systems',
  };
  const makeStages = (answerText: string, requests: AnthropicBatchRequest[][]) => {
    const provider: AnthropicBatchProvider = {
      async create(batchRequests) { requests.push(batchRequests); return { id: `sonnet-${requests.length}`, processing_status: 'in_progress' }; },
      async retrieve(id) { return { id, processing_status: 'ended' }; },
      async results() {
        const request = requests.at(-1)![0];
        return JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: { content: [{
          type: 'text', text: JSON.stringify({ answers: [{ answer: answerText, confidence: 0.95, supportQuote: '' }] }),
        }] } } });
      },
    };
    const store: BatchRunStateStore = {
      async get() { return undefined; }, async put() {}, async claim() { return undefined; }, async claimEventEmission() { return true; },
    };
    return createIngestTier5Stages('sonnet-length', new LLMSynthesizer({
      apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: store,
    }));
  };

  const overlongRequests: AnthropicBatchRequest[][] = [];
  const overlong = await makeStages('I want to solve meaningful problems', overlongRequests)
    .sonnet([item], new Map([[item.fieldKey, answer(item.fieldKey, 'I want to contribute.') .answer]]));
  assert.equal(Array.isArray(overlong) && overlong[0]?.answer, null);
  const prompt = String((overlongRequests[0][0].params.messages as Array<{ content: string }>)[0].content);
  assert.match(prompt, /no more than 5 words/);
  assert.match(prompt, /preserve the candidate's voice/);
  assert.match(prompt, /Organization policy\/context/);

  const compliantRequests: AnthropicBatchRequest[][] = [];
  const compliant = await makeStages('I enjoy solving problems', compliantRequests)
    .sonnet([item], new Map([[item.fieldKey, answer(item.fieldKey, 'I want to contribute.').answer]]));
  assert.equal(Array.isArray(compliant) && compliant[0]?.answer?.value, 'I enjoy solving problems');
});

test('Sonnet DeepSeek R1 fallback accepts a reviewed creative answer without confidence and rejects length violations', async () => {
  const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'In no more than 5 words, why do you want to join our team?', isRequired: true } as any;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ model: string; answer: string }> = [];
  try {
    for (const answerText of ['I value thoughtful collaboration.', 'I want to solve meaningful problems']) {
      const requests: AnthropicBatchRequest[][] = [];
      const provider: AnthropicBatchProvider = {
        async create(batchRequests) { requests.push(batchRequests); return { id: `failed-sonnet-${requests.length}`, processing_status: 'in_progress' }; },
        async retrieve(id) { return { id, processing_status: 'ended' }; },
        async results() {
          const request = requests.at(-1)![0];
          return JSON.stringify({ custom_id: request.custom_id, result: { type: 'errored', error: { type: 'offline-test' } } });
        },
      };
      const store: BatchRunStateStore = { async get() { return undefined; }, async put() {}, async claim() { return undefined; }, async claimEventEmission() { return true; } };
      const item = {
        ...work('candidate-sonnet-r1-length', 'job-sonnet-r1-length', field.fieldId), field,
        profile: { applywizz_id: 'candidate-sonnet-r1-length', client_name: 'Candidate', resume_facts: {} } as any,
      };
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ model: body.model, answer: answerText });
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ answer: answerText }) } }],
          usage: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const stages = createIngestTier5Stages('sonnet-r1-length', new LLMSynthesizer({
        apiKey: 'offline-test', openRouterApiKey: 'offline-test', modelName: 'claude-haiku-5-5',
        batchProvider: provider, batchStateStore: store,
      }));
      const result = await stages.sonnet([item], new Map([[item.fieldKey, answer(item.fieldKey, 'I want to contribute.').answer]]));
      assert.equal(Array.isArray(result) && result[0]?.answer?.value, answerText === 'I value thoughtful collaboration.' ? answerText : undefined);
    }
    assert.equal(calls.length, 2, 'only the mocked OpenRouter fallback was called');
    assert.ok(calls.every(({ model }) => /r1/i.test(model)), 'both fallback requests use the DeepSeek R1 model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves a newer authoritative field value when merging prepared results', () => {
  const proposed: ResolvedField = { fieldId: 'f1', name: 'f1', type: 'text', label: 'Question', value: 'stale AI', source: 'ai', resolvedByTier: 5, confidence: 0.9 };
  const current: ResolvedField = { ...proposed, value: 'operator edit', source: 'supabase', resolvedByTier: 1, confidence: 1 };
  const merged = preserveNewerAuthoritativeAnswers([proposed], [current]);
  assert.equal(merged[0].value, 'operator edit');
  assert.equal(merged[0].source, 'supabase');
  assert.equal(applicationShouldBeFilteredOut(merged), false);
  assert.equal(applicationNeedsOperatorReview(merged), false);
});

test('polls the known Haiku batch through completion before polling Sonnet, without duplicate creates', async () => {
  class Store implements BatchRunStateStore {
    private states = new Map<string, BatchRunState>();
    async get(key: string) { return this.states.get(key); }
    async put(state: BatchRunState) { this.states.set(state.runKey, state); }
    async claim(state: BatchRunState) { const prior = this.states.get(state.runKey); if (prior) return prior; this.states.set(state.runKey, state); }
    async claimEventEmission() { return true; }
  }
  const statuses = new Map<string, number>();
  const creates: string[] = [];
  let sleeps = 0;
  const provider: AnthropicBatchProvider = {
    async create(requests) { const id = `known-${creates.length}`; creates.push(id); return { id, processing_status: 'in_progress' }; },
    async retrieve(id) {
      const count = statuses.get(id) || 0;
      statuses.set(id, count + 1);
      return { id, processing_status: count === 0 ? 'in_progress' : 'ended' };
    },
    async results(id) {
      const customId = id === 'known-0' ? 'haiku-placeholder' : 'sonnet-placeholder';
      const request = (provider as any).requests.get(id).find((candidate: AnthropicBatchRequest) => candidate.custom_id !== customId) || (provider as any).requests.get(id)[0];
      return JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: { content: [{
        type: 'text', text: JSON.stringify({ answers: [{ answer: 'I am excited to contribute to this team.', confidence: 0.95, supportQuote: '' }] }),
      }] } } });
    },
  };
  (provider as any).requests = new Map<string, AnthropicBatchRequest[]>();
  const providerCreate = provider.create.bind(provider);
  provider.create = async (requests) => { const created = await providerCreate(requests); (provider as any).requests.set(created.id, requests); return created; };
  const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'Why do you want to join our team?', isRequired: true } as any;
  const item = { ...work('candidate-a', 'job-1', field.fieldId), field, profile: { applywizz_id: 'candidate-a', client_name: 'Candidate', resume_facts: {} } as any };
  const synthesizer = new LLMSynthesizer({
    apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: new Store(),
    batchPollIntervalMs: 5, batchPollSleep: async (milliseconds) => { assert.equal(milliseconds, 5); sleeps++; },
  });
  const results = await resolveIngestTier5([item], createIngestTier5Stages('poll-ingest', synthesizer));
  assert.deepEqual(creates, ['known-0', 'known-1']);
  assert.equal(statuses.get('known-0'), 2);
  assert.equal(statuses.get('known-1'), 2);
  assert.equal(sleeps, 2);
  assert.match(results.get(item.fieldKey)?.value || '', /^I am excited/);
});

test('bounds each polling interval and stops on abort without another create', async () => {
  const states = new Map<string, BatchRunState>();
  const store: BatchRunStateStore = {
    async get(key) { return states.get(key); },
    async put(state) { states.set(state.runKey, state); },
    async claim(state) { const prior = states.get(state.runKey); if (prior) return prior; states.set(state.runKey, state); },
    async claimEventEmission() { return true; },
  };
  let creates = 0;
  let aborted = false;
  const provider: AnthropicBatchProvider = {
    async create() { creates++; return { id: 'abort-known-id', processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'in_progress' }; },
    async results() { throw new Error('results should not be requested'); },
  };
  await assert.rejects(executeAnthropicBatchWithRetry('abort-run', [{ custom_id: 'q1', params: { max_tokens: 1 } }], provider, store, undefined, {
    waitForCompletion: true,
    intervalMs: 100_000,
    sleep: async (milliseconds) => { assert.equal(milliseconds, 60_000); aborted = true; },
    shouldAbort: () => aborted,
  }), AnthropicBatchPollingAbortedError);
  assert.equal(creates, 1);
});

test('production stage adapter submits one real Message Batch item per field and maps out-of-order results', async () => {
  class Store implements BatchRunStateStore {
    private states = new Map<string, BatchRunState>();
    async get(key: string) { return this.states.get(key); }
    async put(state: BatchRunState) { this.states.set(state.runKey, state); }
    async claim(state: BatchRunState) { const prior = this.states.get(state.runKey); if (prior) return prior; this.states.set(state.runKey, state); }
    async claimEventEmission(runKey: string, eventId: string) {
      const state = this.states.get(runKey)!;
      if (state.emittedEventIds?.includes(eventId)) return false;
      this.states.set(runKey, { ...state, emittedEventIds: [...(state.emittedEventIds || []), eventId] });
      return true;
    }
  }
  class Provider implements AnthropicBatchProvider {
    requests: AnthropicBatchRequest[] = [];
    async create(requests: AnthropicBatchRequest[]) { this.requests = requests; return { id: 'batch-stage-test', processing_status: 'in_progress' as const }; }
    async retrieve(id: string) { return { id, processing_status: 'ended' as const }; }
    async results() {
      return [...this.requests].reverse().map((request) => {
        const prompt = (request.params.messages as Array<{ content: string }>)[0].content;
        const candidate = prompt.match(/Candidate ApplyWizz ID: ([^\n]+)/)?.[1]?.trim() || 'unknown';
        return JSON.stringify({ custom_id: request.custom_id, result: { type: 'succeeded', message: {
          content: [{ type: 'text', text: JSON.stringify({ answers: [{ answer: `I am ${candidate} and I am interested in this role.`, confidence: 0.9, supportQuote: '' }] }) }],
        } } });
      }).join('\n');
    }
  }
  const provider = new Provider();
  const synthesizer = new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: new Store() });
  const items = ['candidate-a', 'candidate-b'].map((candidateId) => {
    const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'Why do you want to join?', isRequired: false } as any;
    return { ...work(candidateId, `job-${candidateId}`, field.fieldId, false), field,
      profile: { applywizz_id: candidateId, client_name: candidateId, resume_facts: {} } as any };
  });
  const stages = createIngestTier5Stages('run-stage-test', synthesizer);
  const results = await stages.haiku(items);
  assert.equal(provider.requests.length, 2);
  assert.equal(new Set(provider.requests.map((request) => request.custom_id)).size, 2);
  assert.ok(provider.requests.every((request) => request.params.model === 'claude-haiku-5-5'));
  assert.equal(results.find((result) => result.fieldKey === items[0].fieldKey)?.answer?.value.includes('candidate-a'), true);
  assert.equal(results.find((result) => result.fieldKey === items[1].fieldKey)?.answer?.value.includes('candidate-b'), true);
});

test('retries malformed Haiku and Sonnet JSON once, then uses the stage fallback without repeating the original batch', async () => {
  for (const stage of ['haiku', 'sonnet'] as const) {
    class Store implements BatchRunStateStore {
      private states = new Map<string, BatchRunState>();
      async get(key: string) { return this.states.get(key); }
      async put(state: BatchRunState) { this.states.set(state.runKey, state); }
      async claim(state: BatchRunState) { const prior = this.states.get(state.runKey); if (prior) return prior; this.states.set(state.runKey, state); }
      async claimEventEmission() { return true; }
    }
    const creates: string[][] = [];
    const provider: AnthropicBatchProvider = {
      async create(requests) { creates.push(requests.map((request) => request.custom_id)); return { id: `batch-${creates.length}`, processing_status: 'in_progress' }; },
      async retrieve(id) { return { id, processing_status: 'ended' }; },
      async results(id) {
        const customId = creates[Number(id.slice('batch-'.length)) - 1][0];
        return JSON.stringify({ custom_id: customId, result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'not-json' }] } } });
      },
    };
    const item = work('candidate-a', 'job-1', `malformed-${stage}`);
    item.field.label = 'Why do you want to join our team?';
    item.profile = { applywizz_id: 'candidate-a', client_name: 'Candidate', resume_facts: {} } as any;
    const synthesizer = new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: new Store() });
    const fallbackModels: string[] = [];
    synthesizer.synthesizeDeepSeekAnswer = async (_field, _profile, _resume, _context, _facts, model) => {
      fallbackModels.push(model);
      return { result: { ...item.field, value: 'I want to join this team.', source: 'ai', resolvedByTier: 5, confidence: 0.9 } as ResolvedField, supportQuote: '' };
    };
    const stages = createIngestTier5Stages(`malformed-${stage}`, synthesizer);
    if (stage === 'haiku') await stages.haiku([item]);
    else await stages.sonnet([item], new Map([[item.fieldKey, null]]));
    assert.equal(creates.length, 2, `${stage} creates the original and one malformed-output retry batch`);
    assert.equal(fallbackModels.length, 1);
    assert.match(fallbackModels[0], stage === 'haiku' ? /flash/i : /r1/i);
  }
});

test('valid low-confidence Haiku output remains an escalation decision, not a provider failure', async () => {
  const item = work('candidate-a', 'job-1', 'low-confidence');
  let sonnetCalled = false;
  const resolved = { ...item.field, value: 'plausible but low confidence', source: 'ai', resolvedByTier: 5, confidence: 0.2 } as ResolvedField;
  await resolveIngestTier5([item], {
    async haiku() { return [{ fieldKey: item.fieldKey, answer: resolved }]; },
    async sonnet(items) { sonnetCalled = true; assert.deepEqual(items.map(({ fieldKey }) => fieldKey), [item.fieldKey]); return []; },
  });
  assert.equal(sonnetCalled, true);
});

test('canonicalizes reversed work before request IDs and batch payload creation', async () => {
  class Store implements BatchRunStateStore {
    state?: BatchRunState;
    async get() { return this.state; }
    async put(state: BatchRunState) { this.state = state; }
    async claim(state: BatchRunState) { if (this.state) return this.state; this.state = state; }
    async claimEventEmission() { return true; }
  }
  class Provider implements AnthropicBatchProvider {
    creates = 0;
    requests?: AnthropicBatchRequest[];
    async create(requests: AnthropicBatchRequest[]) { this.creates++; this.requests = requests; return { id: 'batch-canonical', processing_status: 'in_progress' as const }; }
    async retrieve(id: string) { return { id, processing_status: 'ended' as const }; }
    async results() {
      return (this.requests || []).map(({ custom_id }) => JSON.stringify({
        custom_id,
        result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{"answers":[{"answer":"I want this role","confidence":0.9}]}' }] } },
      })).join('\n');
    }
  }
  const store = new Store();
  const provider = new Provider();
  const synthesizer = new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: store });
  const items = ['candidate-z', 'candidate-a'].map((candidateId) => {
    const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'Why do you want to join?', isRequired: false } as any;
    return { ...work(candidateId, `job-${candidateId}`, field.fieldId, false), field, profile: { applywizz_id: candidateId, client_name: candidateId, resume_facts: {} } as any };
  });
  const stages = createIngestTier5Stages('run-canonical', synthesizer);
  await resolveIngestTier5(items, stages);
  const firstRequests = provider.requests!.map((request) => ({ ...request }));
  await resolveIngestTier5([...items].reverse(), stages);
  assert.equal(provider.creates, 1);
  assert.deepEqual(provider.requests, firstRequests);
});

test('unknown create outcome is reconciliation pending and never falls back', async () => {
  class Store implements BatchRunStateStore {
    state?: BatchRunState;
    async get() { return this.state; }
    async put(state: BatchRunState) { this.state = state; }
    async claim(state: BatchRunState) { if (this.state) return this.state; this.state = state; }
    async claimEventEmission() { return true; }
  }
  class Provider implements AnthropicBatchProvider {
    creates = 0;
    async create() { this.creates++; throw new Error('connection dropped after create'); }
    async retrieve(id: string) { return { id, processing_status: 'ended' as const }; }
    async results() { return ''; }
  }
  const store = new Store();
  const provider = new Provider();
  const field = { fieldId: 'f1', name: 'f1', type: 'text', label: 'How should we reach you?', isRequired: true } as any;
  const item = { ...work('candidate-a', 'job-1', 'f1'), field, profile: { applywizz_id: 'candidate-a', client_name: 'candidate-a', resume_facts: {} } as any };
  const synthesizer = new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: store });
  let fallbackCalls = 0;
  synthesizer.synthesizeDeepSeekAnswer = async () => { fallbackCalls++; throw new Error('must not fall back'); };
  const stages = createIngestTier5Stages('run-unknown-create', synthesizer);
  await assert.rejects(resolveIngestTier5([item], stages), /reconciliation.*application finalization is blocked/i);
  await assert.rejects(resolveIngestTier5([item], stages), /reconciliation.*application finalization is blocked/i);
  assert.equal(provider.creates, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(store.state?.createState, 'outcome_unknown');
});

test('status and results transport failures retry against the known batch ID without duplicate creates', async () => {
  for (const failedOperation of ['retrieve', 'results'] as const) {
    let creates = 0;
    let retrieves = 0;
    let resultReads = 0;
    const states = new Map<string, BatchRunState>();
    const store: BatchRunStateStore = {
      async get(key) { return states.get(key); },
      async put(state) { states.set(state.runKey, state); },
      async claim(state) { const prior = states.get(state.runKey); if (prior) return prior; states.set(state.runKey, state); },
      async claimEventEmission() { return true; },
    };
    const provider: AnthropicBatchProvider = {
      async create() { creates++; return { id: `batch-${failedOperation}`, processing_status: 'in_progress' }; },
      async retrieve(id) { if (failedOperation === 'retrieve' && retrieves++ === 0) throw new Error('transient status read'); return { id, processing_status: 'ended' }; },
      async results(id) { if (failedOperation === 'results' && resultReads++ === 0) throw new Error('transient results read'); return JSON.stringify({ custom_id: 'q1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'ok' }] } } }); },
    };
    const output = await executeAnthropicBatchWithRetry(`transport-${failedOperation}`, [{ custom_id: 'q1', params: { max_tokens: 1 } }], provider, store);
    assert.equal(output.status, 'ended');
    assert.equal(creates, 1);
    assert.equal(retrieves, failedOperation === 'retrieve' ? 2 : 0);
    assert.equal(resultReads, failedOperation === 'results' ? 2 : 0);
  }
});

test('exhausted Haiku and Sonnet status or results transport retries fall back to Flash and R1 for required creative review', async () => {
  for (const failedOperation of ['retrieve', 'results'] as const) {
  class Store implements BatchRunStateStore {
    private states = new Map<string, BatchRunState>();
    async get(key: string) { return this.states.get(key); }
    async put(state: BatchRunState) { this.states.set(state.runKey, state); }
    async claim(state: BatchRunState) { const prior = this.states.get(state.runKey); if (prior) return prior; this.states.set(state.runKey, state); }
    async claimEventEmission() { return true; }
  }
  const created: string[] = [];
  const provider: AnthropicBatchProvider = {
    async create() { const id = `known-${created.length}`; created.push(id); return { id, processing_status: 'in_progress' }; },
    async retrieve(id) { if (failedOperation === 'retrieve') throw new Error(`status transport failed for ${id}`); return { id, processing_status: 'ended' }; },
    async results(id) { if (failedOperation === 'results') throw new Error(`results transport failed for ${id}`); return ''; },
  };
  const field = { fieldId: 'motivation', name: 'motivation', type: 'textarea', label: 'Why do you want to join our team?', isRequired: true } as any;
  const item = { ...work('candidate-a', 'job-1', field.fieldId), field, profile: { applywizz_id: 'candidate-a', client_name: 'Candidate', resume_facts: {} } as any };
  const synthesizer = new LLMSynthesizer({ apiKey: 'test', modelName: 'claude-haiku-5-5', batchProvider: provider, batchStateStore: new Store() });
  const fallbackModels: string[] = [];
  synthesizer.synthesizeDeepSeekAnswer = async (_field, _profile, _resume, _context, _facts, model) => {
    fallbackModels.push(model);
    const value = model === 'flash' ? 'I want to join because the role aligns with my interests.' : 'I want to join because the role aligns with my interests and experience.';
    return { result: { fieldId: field.fieldId, name: field.name, type: field.type, label: field.label, value, source: 'ai', resolvedByTier: 5, confidence: 0.9 } as ResolvedField, supportQuote: '' };
  };
  const stages = createIngestTier5Stages('run-exhausted-creative', synthesizer);
  const result = await resolveIngestTier5([item], stages);
  assert.deepEqual(created, ['known-0', 'known-1']);
  assert.equal(fallbackModels.length, 2);
  assert.match(fallbackModels[0], /flash/i);
  assert.match(fallbackModels[1], /r1/i);
  assert.ok(result.get(item.fieldKey)?.value.includes('I want to join'));
  }
});
