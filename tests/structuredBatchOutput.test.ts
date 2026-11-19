import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMSynthesizer, parseBatchAnswerResponse } from '../src/resolver/llmSynthesizer.js';
import {
  executeAnthropicBatch,
  executeAnthropicBatchWithRetry,
  parseAnthropicResultsJsonl,
  stableBatchCustomIds,
  validateBatchRequests,
  type AnthropicBatchProvider,
  type AnthropicBatchRequest,
  type BatchRunState,
  type BatchRunStateStore,
} from '../src/resolver/anthropicMessageBatch.js';

class FakeBatchStore implements BatchRunStateStore {
  states = new Map<string, BatchRunState>();
  async get(key: string) { return this.states.get(key); }
  async put(state: BatchRunState) { this.states.set(state.runKey, state); }
  async claim(state: BatchRunState) {
    const prior = this.states.get(state.runKey);
    if (prior) return prior;
    this.states.set(state.runKey, state);
    return undefined;
  }
  async claimEventEmission(runKey: string, eventId: string) {
    const state = this.states.get(runKey);
    assert.ok(state, `state exists before claiming ${eventId}`);
    if (state.emittedEventIds?.includes(eventId)) return false;
    this.states.set(runKey, { ...state, emittedEventIds: [...(state.emittedEventIds ?? []), eventId] });
    return true;
  }
}

class FakeBatchProvider implements AnthropicBatchProvider {
  creates = 0;
  status: 'in_progress' | 'canceling' | 'ended' = 'ended';
  jsonl = '';
  async create(requests: AnthropicBatchRequest[]) {
    this.creates++;
    assert.equal(requests.some((request) => request.params.stream === true), false);
    return { id: 'msgbatch_fake', processing_status: 'in_progress' as const };
  }
  async retrieve(id: string) {
    assert.equal(id, 'msgbatch_fake');
    return { id, processing_status: this.status };
  }
  async results(id: string) { assert.equal(id, 'msgbatch_fake'); return this.jsonl; }
}

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

test('Message Batch protocol matches out-of-order JSONL by stable custom ID', async () => {
  const questions = [{ label: 'same', type: 'text' }, { label: 'same', type: 'text' }];
  const ids = stableBatchCustomIds('run/one', questions);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(ids, stableBatchCustomIds('run/one', questions));
  const requests = ids.map((custom_id) => ({ custom_id, params: { model: 'claude-haiku-5-5', max_tokens: 20 } }));
  const provider = new FakeBatchProvider();
  provider.jsonl = [
    JSON.stringify({ custom_id: ids[1], result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'second' }], usage: { input_tokens: 5, output_tokens: 2 } } } }),
    JSON.stringify({ custom_id: ids[0], result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'first' }] } } }),
  ].join('\n');
  const store = new FakeBatchStore();
  const result = await executeAnthropicBatch('run/one', requests, provider, store);
  assert.equal(result.status, 'ended');
  assert.equal(result.results?.get(ids[0])?.result.message?.content?.[0]?.text, 'first');
  assert.equal(result.results?.get(ids[1])?.result.message?.content?.[0]?.text, 'second');
  assert.equal(provider.creates, 1);
});

test('runAnthropicPromptBatch returns actual aggregate token usage from provider results', async () => {
  const ids = stableBatchCustomIds('usage-run:haiku', [{ label: 'usage', type: 'text' }]);
  const provider: AnthropicBatchProvider = {
    async create() { return { id: 'usage-batch', processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results() { return JSON.stringify({ custom_id: ids[0], result: { type: 'succeeded', message: { content: [{ type: 'text', text: '{"answers":[{"answer":"ok"}]}' }], usage: { input_tokens: 13, output_tokens: 7 } } } }); },
  };
  const result = await new LLMSynthesizer({ apiKey: 'test', batchProvider: provider, batchStateStore: new FakeBatchStore() }).runAnthropicPromptBatch(
    'usage-run:haiku', [{ customId: ids[0], prompt: 'q', system: 's' }], 'claude-haiku-5-5',
  );
  assert.deepEqual(result.usage, { promptTokens: 13, completionTokens: 7 });
  assert.deepEqual(result.batchIds, ['usage-batch']);
});

test('Message Batch validation and JSONL parser reject duplicates, malformed data, streaming and bad limits', () => {
  const request = { custom_id: 'one', params: { model: 'claude-haiku-5-5', max_tokens: 1 } };
  assert.throws(() => validateBatchRequests([request, request]), /duplicate/);
  assert.throws(() => validateBatchRequests([{ ...request, params: { ...request.params, stream: true } }]), /streaming/);
  assert.throws(() => validateBatchRequests([{ ...request, params: { ...request.params, max_tokens: 0 } }]), /max_tokens/);
  assert.throws(() => parseAnthropicResultsJsonl('not json', ['one']), /Malformed/);
  const item = JSON.stringify({ custom_id: 'one', result: { type: 'errored', error: { type: 'server_error' } } });
  assert.throws(() => parseAnthropicResultsJsonl(`${item}\n${item}`, ['one']), /Duplicate/);
  assert.equal(parseAnthropicResultsJsonl('', ['one']).get('one')?.result.error?.type, 'missing_result');
  for (const type of ['canceled', 'expired']) {
    assert.equal(parseAnthropicResultsJsonl(JSON.stringify({ custom_id: 'one', result: { type } }), ['one']).get('one')?.result.type, type);
  }
});

test('Message Batch preserves partial errors and resumes an accepted batch without another create', async () => {
  const ids = ['one', 'two'];
  const requests = ids.map((custom_id) => ({ custom_id, params: { model: 'claude-sonnet-5', max_tokens: 40 } }));
  const provider = new FakeBatchProvider();
  provider.status = 'in_progress';
  const store = new FakeBatchStore();
  const pending = await executeAnthropicBatch('resume-me', requests, provider, store);
  assert.equal(pending.status, 'in_progress');
  provider.status = 'canceling';
  assert.equal((await executeAnthropicBatch('resume-me', requests, provider, store)).status, 'canceling');
  provider.status = 'ended';
  provider.jsonl = JSON.stringify({ custom_id: 'two', result: { type: 'errored', error: { type: 'server_error' } } });
  const resumed = await executeAnthropicBatch('resume-me', requests, provider, store);
  assert.equal(resumed.results?.get('one')?.result.error?.type, 'missing_result');
  assert.equal(resumed.results?.get('two')?.result.type, 'errored');
  assert.equal(provider.creates, 1);
});

test('Message Batch refuses duplicate submission when create outcome is unknown', async () => {
  const provider = new FakeBatchProvider();
  provider.create = async () => { provider.creates++; throw new Error('connection reset'); };
  const store = new FakeBatchStore();
  const requests = [{ custom_id: 'one', params: { model: 'claude-haiku-5-5', max_tokens: 1 } }];
  await assert.rejects(executeAnthropicBatch('unknown', requests, provider, store), /connection reset/);
  await assert.rejects(executeAnthropicBatch('unknown', requests, provider, store), /no recorded ID.*refusing duplicate/i);
  assert.equal(provider.creates, 1);
});

test('Message Batch retries provider item errors exactly once and keeps final results keyed to original IDs', async () => {
  const store = new FakeBatchStore();
  let creates = 0;
  let retryId = '';
  const provider: AnthropicBatchProvider = {
    async create(requests) { creates++; if (creates === 2) retryId = requests[0].custom_id; return { id: `batch-${creates}`, processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results(id) {
      const items = id === 'batch-1'
        ? [
          { custom_id: 'field_a', result: { type: 'errored', error: { type: 'server_error' } } },
          { custom_id: 'field_b', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'kept' }], usage: { input_tokens: 4, output_tokens: 2 } } } },
        ]
        : [{ custom_id: retryId, result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'resolved' }], usage: { input_tokens: 8, output_tokens: 3 } } } }];
      return items.map((item) => JSON.stringify(item)).join('\n');
    },
  };
  const events: Array<{ event: string; eventId?: string; batchId: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
  const result = await executeAnthropicBatchWithRetry('retry-case', [
    { custom_id: 'field_a', params: { model: 'claude-haiku-5-5', max_tokens: 12 } },
    { custom_id: 'field_b', params: { model: 'claude-haiku-5-5', max_tokens: 12 } },
  ], provider, store, (event) => events.push(event));
  assert.equal(creates, 2);
  assert.deepEqual(result.batchIds, ['batch-1', 'batch-2']);
  assert.equal(result.results?.get('field_a')?.result.type, 'succeeded');
  assert.equal(result.results?.get('field_a')?.result.message?.usage?.input_tokens, 8);
  assert.equal(events.filter((event) => event.event === 'item_error').length, 1);
  assert.deepEqual(events.map(({ event, batchId }) => [event, batchId]), [
    ['completed', 'batch-1'],
    ['item_error', 'batch-1'],
    ['completed', 'batch-2'],
  ]);
  assert.deepEqual(events.filter((event) => event.event === 'completed').map((event) => event.usage), [
    { inputTokens: 4, outputTokens: 2 },
    { inputTokens: 12, outputTokens: 5 },
  ]);
});

test('Message Batch returns cumulative usage snapshots while retry is pending and on completion', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'batch-poll-events-'));
  const statePath = join(directory, 'state.json');
  const { JsonBatchRunStateStore } = await import('../src/resolver/anthropicMessageBatch.js');
  let retryId = '';
  let retryPolls = 0;
  const provider: AnthropicBatchProvider = {
    async create(requests) {
      if (requests[0].custom_id !== 'field_a') retryId = requests[0].custom_id;
      return { id: requests[0].custom_id === 'field_a' ? 'usage-first' : 'usage-retry', processing_status: 'in_progress' };
    },
    async retrieve(id) {
      if (id === 'usage-retry' && ++retryPolls >= 3) return { id, processing_status: 'ended' };
      return { id, processing_status: id === 'usage-first' ? 'ended' : 'in_progress' };
    },
    async results(id) {
      const items = id === 'usage-first'
        ? [
          { custom_id: 'field_a', result: { type: 'errored', error: { type: 'server_error' } } },
          { custom_id: 'field_b', result: { type: 'succeeded', message: { usage: { input_tokens: 4, output_tokens: 2 } } } },
        ]
        : [{ custom_id: retryId, result: { type: 'succeeded', message: { usage: { input_tokens: 8, output_tokens: 3 } } } }];
      return items.map((item) => JSON.stringify(item)).join('\n');
    },
  };
  const requests = ['field_a', 'field_b'].map((custom_id) => ({ custom_id, params: { model: 'claude-haiku-5-5', max_tokens: 12 } }));
  const events: Array<{ event: string; eventId?: string; batchId: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
  const invocationEvents: Array<typeof events> = [];
  const poll = () => {
    const currentEvents: typeof events = [];
    invocationEvents.push(currentEvents);
    const store = new JsonBatchRunStateStore(statePath);
    return executeAnthropicBatchWithRetry('pending-usage', requests, provider, store, (event) => {
      events.push(event);
      currentEvents.push(event);
    });
  };

  const pending1 = await poll();
  const pending2 = await poll();
  const completed = await poll();
  assert.equal(pending1.status, 'in_progress');
  assert.equal(pending2.status, 'in_progress');
  assert.deepEqual(pending1.usage, { inputTokens: 4, outputTokens: 2 });
  assert.deepEqual(pending2.usage, pending1.usage, 'resumes return the same cumulative snapshot, not another increment');
  assert.deepEqual(completed.usage, { inputTokens: 12, outputTokens: 5 });
  assert.deepEqual(events.filter((event) => event.event === 'pending').map(({ batchId, usage }) => [batchId, usage]), [
    ['usage-retry', pending1.usage],
    ['usage-retry', pending2.usage],
  ]);
  assert.deepEqual(invocationEvents.map((callEvents) => callEvents.map(({ event, batchId }) => [event, batchId])), [
    [['completed', 'usage-first'], ['item_error', 'usage-first'], ['pending', 'usage-retry']],
    [['pending', 'usage-retry']],
    [['completed', 'usage-retry']],
  ]);
  assert.deepEqual(invocationEvents[0].map(({ usage }) => usage), [
    pending1.usage,
    undefined,
    pending1.usage,
  ]);
  assert.deepEqual(invocationEvents[1].map(({ usage }) => usage), [pending2.usage]);
  assert.deepEqual(invocationEvents[2].filter((event) => event.event === 'completed').map(({ usage }) => usage), [
    completed.usage,
  ]);
  const completedEvents = events.filter((event) => event.event === 'completed');
  assert.deepEqual(completedEvents.map(({ batchId }) => batchId), ['usage-first', 'usage-retry']);
  assert.equal(new Set(completedEvents.map(({ eventId }) => eventId)).size, 2, 'completion IDs let downstream consumers deduplicate crash-window retries');
  const itemErrorEvents = events.filter((event) => event.event === 'item_error');
  assert.equal(itemErrorEvents.length, 1, 'repeated polls emit one item-error accounting event');
  assert.match(itemErrorEvents[0].eventId ?? '', /^batch-item-error:/, 'item-error events carry a stable ID');
  await rm(directory, { recursive: true, force: true });
});

test('Message Batch reports aggregate usage once on a clean completion', async () => {
  const provider: AnthropicBatchProvider = {
    async create() { return { id: 'clean-usage', processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results() {
      return [
        { custom_id: 'one', result: { type: 'succeeded', message: { usage: { input_tokens: 10, output_tokens: 4 } } } },
        { custom_id: 'two', result: { type: 'succeeded', message: { usage: { input_tokens: 5, output_tokens: 2 } } } },
      ].map((item) => JSON.stringify(item)).join('\n');
    },
  };
  const events: Array<{ event: string; batchId: string; usage?: { inputTokens: number; outputTokens: number } }> = [];
  const result = await executeAnthropicBatchWithRetry('clean-usage-run', [
    { custom_id: 'one', params: { model: 'claude-haiku-5-5', max_tokens: 12 } },
    { custom_id: 'two', params: { model: 'claude-haiku-5-5', max_tokens: 12 } },
  ], provider, new FakeBatchStore(), (event) => events.push(event));
  assert.equal(result.status, 'ended');
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 6 });
  assert.deepEqual(events.map(({ event, batchId }) => [event, batchId]), [['completed', 'clean-usage']]);
  assert.deepEqual(events.filter((event) => event.usage).map((event) => event.usage), [{ inputTokens: 15, outputTokens: 6 }]);
});

test('Message Batch does not retry invalid requests or synthetic missing results', async () => {
  let creates = 0;
  const provider: AnthropicBatchProvider = {
    async create() { return { id: `no-retry-${++creates}`, processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results() { return JSON.stringify({ custom_id: 'bad', result: { type: 'errored', error: { type: 'invalid_request_error' } } }); },
  };
  const result = await executeAnthropicBatchWithRetry('invalid', [
    { custom_id: 'bad', params: { model: 'claude-haiku-5-5', max_tokens: 1 } },
    { custom_id: 'omitted', params: { model: 'claude-haiku-5-5', max_tokens: 1 } },
  ], provider, new FakeBatchStore());
  assert.equal(creates, 1);
  assert.equal(result.results?.get('bad')?.result.error?.type, 'invalid_request_error');
  assert.equal(result.results?.get('omitted')?.result.error?.type, 'missing_result');
});

test('Message Batch retries canceled and expired items once and maps results to original IDs', async () => {
  const originalIds = ['canceled-item', 'expired-item'];
  let createCount = 0;
  let firstAttemptIds: string[] = [];
  let retryAttemptIds: string[] = [];
  const provider: AnthropicBatchProvider = {
    async create(requests) {
      createCount++;
      const ids = requests.map(({ custom_id }) => custom_id);
      if (createCount === 1) firstAttemptIds = ids;
      else retryAttemptIds = ids;
      return { id: `cancel-expire-${createCount}`, processing_status: 'in_progress' };
    },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results(id) {
      const ids = id === 'cancel-expire-1' ? firstAttemptIds : retryAttemptIds;
      return ids.map((custom_id, index) => JSON.stringify({
        custom_id,
        result: id === 'cancel-expire-1'
          ? { type: index === 0 ? 'canceled' : 'expired' }
          : { type: 'succeeded', message: { content: [{ type: 'text', text: custom_id }] } },
      })).join('\n');
    },
  };
  const result = await executeAnthropicBatchWithRetry('cancel-expire', originalIds.map((custom_id) => ({
    custom_id,
    params: { model: 'claude-haiku-5-5', max_tokens: 1 },
  })), provider, new FakeBatchStore());
  assert.equal(createCount, 2);
  assert.equal(result.results?.get(originalIds[0])?.result.type, 'succeeded');
  assert.equal(result.results?.get(originalIds[1])?.result.type, 'succeeded');
  assert.deepEqual([...result.results!.keys()], originalIds);
  assert.ok(retryAttemptIds.every((id) => !originalIds.includes(id)));
});

test('Message Batch retries use distinct bounded IDs when original IDs share a prefix', async () => {
  const originals = [`${'x'.repeat(60)}a`, `${'x'.repeat(60)}b`];
  const requests = originals.map((custom_id) => ({ custom_id, params: { model: 'claude-haiku-5-5', max_tokens: 12 } }));
  const sent: string[][] = [];
  let batch = 0;
  const provider: AnthropicBatchProvider = {
    async create(items) { sent.push(items.map((item) => item.custom_id)); return { id: `collision-${++batch}`, processing_status: 'in_progress' }; },
    async retrieve(id) { return { id, processing_status: 'ended' }; },
    async results(id) {
      const ids = sent[id === 'collision-1' ? 0 : 1];
      return ids.map((custom_id) => JSON.stringify({ custom_id, result: id === 'collision-1' ? { type: 'errored', error: { type: 'server_error' } } : { type: 'succeeded' } })).join('\n');
    },
  };
  const result = await executeAnthropicBatchWithRetry('collision', requests, provider, new FakeBatchStore());
  assert.equal(new Set(sent[1]).size, 2);
  assert.ok(sent[1].every((id) => id.length <= 64));
  assert.deepEqual([...result.results!.keys()], originals);
});

test('Message Batch run key rejects changed payload even when request IDs match', async () => {
  const store = new FakeBatchStore();
  const provider = new FakeBatchProvider();
  const first = [{ custom_id: 'same', params: { model: 'claude-haiku-5-5', max_tokens: 12, messages: [{ role: 'user', content: 'evidence one' }] } }];
  await executeAnthropicBatch('stale', first, provider, store);
  const changed = [{ ...first[0], params: { ...first[0].params, messages: [{ role: 'user', content: 'evidence two' }] } }];
  await assert.rejects(executeAnthropicBatch('stale', changed, provider, store), /different request payload/);
  assert.equal(provider.creates, 1);
});

test('Message Batch local state claim allows only one concurrent submit', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'batch-state-'));
  try {
    const { JsonBatchRunStateStore } = await import('../src/resolver/anthropicMessageBatch.js');
    const store = new JsonBatchRunStateStore(join(directory, 'state.json'));
    let creates = 0;
    const provider: AnthropicBatchProvider = {
      async create() { creates++; await new Promise((resolve) => setTimeout(resolve, 25)); return { id: 'concurrent', processing_status: 'in_progress' }; },
      async retrieve(id) { return { id, processing_status: 'in_progress' }; },
      async results() { return ''; },
    };
    const request = [{ custom_id: 'only', params: { model: 'claude-haiku-5-5', max_tokens: 1 } }];
    const outcomes = await Promise.allSettled([
      executeAnthropicBatch('same-run', request, provider, store),
      executeAnthropicBatch('same-run', request, provider, store),
    ]);
    assert.equal(creates, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Message Batch completion emission claim survives store reconstruction', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'batch-event-claim-'));
  const statePath = join(directory, 'state.json');
  try {
    const { JsonBatchRunStateStore } = await import('../src/resolver/anthropicMessageBatch.js');
    const firstStore = new JsonBatchRunStateStore(statePath);
    await firstStore.put({ runKey: 'event-run', batchId: 'batch-once', createState: 'accepted', customIds: [], requestHash: 'hash' });
    assert.equal(await firstStore.claimEventEmission('event-run', 'batch-completed:batch-once'), true);
    const restartedStore = new JsonBatchRunStateStore(statePath);
    assert.equal(await restartedStore.claimEventEmission('event-run', 'batch-completed:batch-once'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Message Batch stale lock fails closed until an operator removes it with all writers stopped', async () => {
  const { mkdtemp, rm, unlink, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'batch-stale-lock-'));
  const statePath = join(directory, 'state.json');
  const store = new (await import('../src/resolver/anthropicMessageBatch.js')).JsonBatchRunStateStore(statePath);
  const lockPath = `${statePath}.lock`;
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner', createdAt: Date.now() }));
    await assert.rejects(store.claim({ runKey: 'after-crash', createState: 'creating', customIds: [], requestHash: 'hash' }), /stopped process.*manual lock cleanup procedure/);
    await unlink(lockPath);
    assert.equal(await store.claim({ runKey: 'after-crash', createState: 'creating', customIds: [], requestHash: 'hash' }), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Message Batch does not allow a second writer to take over a live lock', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'batch-live-lock-'));
  const statePath = join(directory, 'state.json');
  const store = new (await import('../src/resolver/anthropicMessageBatch.js')).JsonBatchRunStateStore(statePath);
  try {
    await writeFile(`${statePath}.lock`, JSON.stringify({ pid: process.pid, token: 'live-owner', createdAt: Date.now() }));
    await assert.rejects(store.claim({ runKey: 'live-lock', createState: 'creating', customIds: [], requestHash: 'hash' }), /owned by live process/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
