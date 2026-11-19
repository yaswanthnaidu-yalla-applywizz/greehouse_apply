import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type AnthropicBatchStatus = 'in_progress' | 'canceling' | 'ended';
export type AnthropicItemStatus = 'succeeded' | 'errored' | 'canceled' | 'expired';

export interface AnthropicBatchRequest {
  custom_id: string;
  params: Record<string, unknown>;
}

export interface AnthropicBatchItem {
  custom_id: string;
  result: {
    type: AnthropicItemStatus;
    message?: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    error?: { type?: string; message?: string };
  };
}

export interface AnthropicBatchProvider {
  create(requests: AnthropicBatchRequest[]): Promise<{ id: string; processing_status: AnthropicBatchStatus }>;
  retrieve(id: string): Promise<{ id: string; processing_status: AnthropicBatchStatus; results_url?: string | null }>;
  results(id: string): Promise<string>;
}

export interface BatchRunState {
  runKey: string;
  batchId?: string;
  createState: 'creating' | 'accepted' | 'outcome_unknown';
  customIds: string[];
  requestHash: string;
  emittedEventIds?: string[];
}

export interface BatchRunStateStore {
  get(runKey: string): Promise<BatchRunState | undefined>;
  put(state: BatchRunState): Promise<void>;
  claim(state: BatchRunState): Promise<BatchRunState | undefined>;
  claimEventEmission(runKey: string, eventId: string): Promise<boolean>;
}

export class BatchReconciliationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchReconciliationRequiredError';
  }
}

export class AnthropicBatchPollingAbortedError extends Error {
  constructor() {
    super('Anthropic Message Batch polling aborted.');
    this.name = 'AnthropicBatchPollingAbortedError';
  }
}

export class JsonBatchRunStateStore implements BatchRunStateStore {
  constructor(private readonly path: string) {}
  async get(runKey: string): Promise<BatchRunState | undefined> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, BatchRunState>;
      return data[runKey];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async put(state: BatchRunState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = await this.acquireLock();
    try {
      let data: Record<string, BatchRunState> = {};
      try { data = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      data[state.runKey] = state;
      const tempPath = `${this.path}.${createHash('sha256').update(state.runKey).digest('hex')}.tmp`;
      await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await rename(tempPath, this.path);
    } finally {
      await this.releaseLock(lock);
    }
  }
  async claim(state: BatchRunState): Promise<BatchRunState | undefined> {
    await mkdir(dirname(this.path), { recursive: true });
    let lock: Awaited<ReturnType<JsonBatchRunStateStore['acquireLock']>>;
    try { lock = await this.acquireLock(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Batch state lock is held')) throw error;
      const prior = await this.get(state.runKey);
      if (prior) return prior;
      throw new Error(`Batch run is concurrently being claimed; refusing duplicate submission. ${error.message}`);
    }
    try {
      const prior = await this.get(state.runKey);
      if (prior) return prior;
      let data: Record<string, BatchRunState> = {};
      try { data = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      data[state.runKey] = state;
      const tempPath = `${this.path}.${createHash('sha256').update(state.runKey).digest('hex')}.tmp`;
      await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await rename(tempPath, this.path);
      return undefined;
    } finally {
      await this.releaseLock(lock);
    }
  }

  async claimEventEmission(runKey: string, eventId: string): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = await this.acquireLock();
    try {
      let data: Record<string, BatchRunState> = {};
      try { data = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const state = data[runKey];
      if (!state) throw new Error(`Batch run state missing while claiming event ${eventId}.`);
      if (state.emittedEventIds?.includes(eventId)) return false;
      data[runKey] = { ...state, emittedEventIds: [...(state.emittedEventIds ?? []), eventId] };
      const tempPath = `${this.path}.${createHash('sha256').update(runKey).digest('hex')}.tmp`;
      await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await rename(tempPath, this.path);
      return true;
    } finally {
      await this.releaseLock(lock);
    }
  }

  private async acquireLock() {
    const lockPath = `${this.path}.lock`;
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readLockOwner(lockPath);
      const detail = owner
        ? isProcessAlive(owner.pid) ? `owned by live process ${owner.pid}` : `owned by stopped process ${owner.pid}; stop every writer, then follow the documented manual lock cleanup procedure`
        : 'has unknown ownership; stop every writer, wait for initialization to finish, then follow the documented manual lock cleanup procedure';
      throw new Error(`Batch state lock is held (${detail}).`);
    }
    const owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
    try {
      await lock.writeFile(JSON.stringify(owner), 'utf8');
      return { lock, owner };
    } catch (error) {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  private async releaseLock(held: Awaited<ReturnType<JsonBatchRunStateStore['acquireLock']>>) {
    await held.lock.close();
    const lockPath = `${this.path}.lock`;
    try {
      const owner = parseLockOwner(await readFile(lockPath, 'utf8'));
      if (owner?.token === held.owner.token && owner.pid === held.owner.pid) await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function parseLockOwner(raw: string): { pid: number; token: string; createdAt: number } | undefined {
  try {
    const value = JSON.parse(raw) as Partial<{ pid: number; token: string; createdAt: number }>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? value as { pid: number; token: string; createdAt: number }
      : undefined;
  } catch { return undefined; }
}

async function readLockOwner(lockPath: string) {
  try { return parseLockOwner(await readFile(lockPath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EINVAL') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

export class AnthropicHttpBatchProvider implements AnthropicBatchProvider {
  constructor(private readonly apiKey: string, private readonly workspaceId?: string) {}
  private async request(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...(this.workspaceId ? { 'anthropic-workspace-id': this.workspaceId } : {}),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: init?.signal ?? AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const error = new Error(`Anthropic Message Batches returned HTTP ${response.status}: ${(await response.text()).slice(0, 2048)}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }
    return response;
  }
  async create(requests: AnthropicBatchRequest[]) {
    return await (await this.request('https://api.anthropic.com/v1/messages/batches', {
      method: 'POST', body: JSON.stringify({ requests }),
    })).json() as { id: string; processing_status: AnthropicBatchStatus };
  }
  async retrieve(id: string) {
    return await (await this.request(`https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(id)}`)).json() as {
      id: string; processing_status: AnthropicBatchStatus; results_url?: string | null;
    };
  }
  async results(id: string) {
    return await (await this.request(`https://api.anthropic.com/v1/messages/batches/${encodeURIComponent(id)}/results`)).text();
  }
}

export function stableBatchCustomIds(runKey: string, questions: readonly unknown[]): string[] {
  const prefix = createHash('sha256').update(runKey).digest('hex').slice(0, 24);
  return questions.map((question, index) => `${prefix}_${index}_${createHash('sha256').update(JSON.stringify(question)).digest('hex').slice(0, 12)}`);
}

export function validateBatchRequests(requests: readonly AnthropicBatchRequest[]): void {
  if (requests.length > 100_000) throw new Error('Anthropic batch exceeds 100,000 requests.');
  const ids = new Set<string>();
  for (const request of requests) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.custom_id) || ids.has(request.custom_id)) {
      throw new Error(`Invalid or duplicate Anthropic custom_id: ${request.custom_id}`);
    }
    ids.add(request.custom_id);
    if (request.params.stream === true) throw new Error('Anthropic Message Batches do not support streaming.');
    if (typeof request.params.max_tokens !== 'number' || request.params.max_tokens < 1) {
      throw new Error('Anthropic batch max_tokens must be at least 1.');
    }
  }
  if (Buffer.byteLength(JSON.stringify({ requests })) > 256 * 1024 * 1024) {
    throw new Error('Anthropic batch exceeds 256 MB.');
  }
}

export function parseAnthropicResultsJsonl(jsonl: string, expectedIds: readonly string[]): Map<string, AnthropicBatchItem> {
  const expected = new Set(expectedIds);
  const results = new Map<string, AnthropicBatchItem>();
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item: AnthropicBatchItem;
    try { item = JSON.parse(line) as AnthropicBatchItem; }
    catch { throw new Error(`Malformed Anthropic JSONL result at line ${index + 1}.`); }
    if (!item.custom_id || !expected.has(item.custom_id)) throw new Error(`Unknown Anthropic result custom_id: ${item.custom_id}`);
    if (results.has(item.custom_id)) throw new Error(`Duplicate Anthropic result custom_id: ${item.custom_id}`);
    if (!['succeeded', 'errored', 'canceled', 'expired'].includes(item.result?.type)) {
      throw new Error(`Invalid Anthropic item result status for ${item.custom_id}.`);
    }
    results.set(item.custom_id, item);
  }
  for (const id of expected) {
    if (!results.has(id)) results.set(id, { custom_id: id, result: { type: 'errored', error: { type: 'missing_result', message: 'Ended batch omitted this request result.' } } });
  }
  return results;
}

export async function executeAnthropicBatch(
  runKey: string,
  requests: AnthropicBatchRequest[],
  provider: AnthropicBatchProvider,
  store: BatchRunStateStore,
): Promise<{ state: BatchRunState; status: AnthropicBatchStatus; results?: Map<string, AnthropicBatchItem> }> {
  const state = await createOrResumeBatch(runKey, requests, provider, store);
  const status = await provider.retrieve(state.batchId!);
  if (status.processing_status !== 'ended') return { state, status: status.processing_status };
  return { state, status: 'ended', results: parseAnthropicResultsJsonl(await provider.results(state.batchId!), state.customIds) };
}

/** `usage` is a cumulative snapshot for the run, so resumed pending results replace earlier measurements. */
export async function executeAnthropicBatchWithRetry(
  runKey: string,
  requests: AnthropicBatchRequest[],
  provider: AnthropicBatchProvider,
  store: BatchRunStateStore,
  onEvent?: (event: { event: 'created' | 'pending' | 'completed' | 'item_error'; eventId?: string; batchId: string; elapsedMs: number; usage?: { inputTokens: number; outputTokens: number } }) => void,
  polling: { waitForCompletion?: boolean; intervalMs?: number; sleep?: (milliseconds: number) => Promise<void>; shouldAbort?: () => boolean } = {},
): Promise<{ status: AnthropicBatchStatus; batchIds: string[]; usage?: { inputTokens: number; outputTokens: number }; results?: Map<string, AnthropicBatchItem> }> {
  const startedAt = Date.now();
  const intervalMs = Math.min(60_000, Math.max(1, polling.intervalMs ?? 15_000));
  const sleep = polling.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const executeWithTransportRetry = async (key: string, batchRequests: AnthropicBatchRequest[]) => {
    try { return await executeAnthropicBatch(key, batchRequests, provider, store); }
    catch (error) {
      if (error instanceof BatchReconciliationRequiredError) throw error;
      // Re-entering with persisted state resumes a known batch ID; uncertain creates fail closed.
      return await executeAnthropicBatch(key, batchRequests, provider, store);
    }
  };
  const pollUntilEnded = async (key: string, batchRequests: AnthropicBatchRequest[], pendingUsage?: { inputTokens: number; outputTokens: number }) => {
    while (true) {
      if (polling.shouldAbort?.()) throw new AnthropicBatchPollingAbortedError();
      const result = await executeWithTransportRetry(key, batchRequests);
      if (result.status === 'ended' && result.results) return result;
      onEvent?.({ event: 'pending', batchId: result.state.batchId!, elapsedMs: Date.now() - startedAt, ...(pendingUsage ? { usage: { ...pendingUsage } } : {}) });
      if (!polling.waitForCompletion) return result;
      await sleep(intervalMs);
    }
  };
  const first = await pollUntilEnded(runKey, requests);
  if (first.status !== 'ended' || !first.results) return { status: first.status, batchIds: [first.state.batchId!] };
  const usage = usageForResults(first.results);
  const retryable = requests.filter((request) => {
    const item = first.results!.get(request.custom_id);
    if (item?.result.type === 'canceled' || item?.result.type === 'expired') return true;
    const errorType = item?.result.error?.type;
    return item?.result.type === 'errored' && Boolean(errorType) && errorType !== 'invalid_request_error' && errorType !== 'missing_result';
  });
  if (retryable.length === 0) {
    await emitCompletedOnce(store, first.state, onEvent, Date.now() - startedAt, usage);
    return { status: 'ended', batchIds: [first.state.batchId!], usage, results: first.results };
  }
  await emitCompletedOnce(store, first.state, onEvent, Date.now() - startedAt, usage);
  for (const request of retryable) {
    await emitItemErrorOnce(store, first.state, request.custom_id, onEvent, Date.now() - startedAt);
  }
  const retryRequests = retryable.map((request) => ({
    ...request,
    custom_id: `r_${createHash('sha256').update(request.custom_id).digest('hex').slice(0, 60)}`,
  }));
  const retry = await pollUntilEnded(`${runKey}-retry1`, retryRequests, usage);
  if (retry.status !== 'ended' || !retry.results) {
    return { status: retry.status, batchIds: [first.state.batchId!, retry.state.batchId!], usage };
  }
  addUsage(usage, usageForResults(retry.results));
  const merged = new Map(first.results);
  for (let index = 0; index < retryable.length; index++) {
    const originalId = retryable[index].custom_id;
    const retried = retry.results.get(retryRequests[index].custom_id);
    if (retried) merged.set(originalId, { ...retried, custom_id: originalId });
  }
  await emitCompletedOnce(store, retry.state, onEvent, Date.now() - startedAt, usage);
  return { status: 'ended', batchIds: [first.state.batchId!, retry.state.batchId!], usage, results: merged };
}

async function emitCompletedOnce(
  store: BatchRunStateStore,
  state: BatchRunState,
  onEvent: ((event: { event: 'created' | 'pending' | 'completed' | 'item_error'; eventId?: string; batchId: string; elapsedMs: number; usage?: { inputTokens: number; outputTokens: number } }) => void) | undefined,
  elapsedMs: number,
  usage: { inputTokens: number; outputTokens: number },
) {
  if (!onEvent) return;
  const batchId = state.batchId!;
  const eventId = `batch-completed:${batchId}`;
  if (await store.claimEventEmission(state.runKey, eventId)) {
    onEvent?.({ event: 'completed', eventId, batchId, elapsedMs, usage: { ...usage } });
  }
}

async function emitItemErrorOnce(
  store: BatchRunStateStore,
  state: BatchRunState,
  customId: string,
  onEvent: ((event: { event: 'created' | 'pending' | 'completed' | 'item_error'; eventId?: string; batchId: string; elapsedMs: number; usage?: { inputTokens: number; outputTokens: number } }) => void) | undefined,
  elapsedMs: number,
) {
  if (!onEvent) return;
  const batchId = state.batchId!;
  const itemKey = createHash('sha256').update(JSON.stringify([batchId, customId])).digest('hex');
  const eventId = `batch-item-error:${itemKey}`;
  // Claim-before-callback prevents duplicate accounting; a crash in between can omit this event.
  if (await store.claimEventEmission(state.runKey, eventId)) {
    onEvent({ event: 'item_error', eventId, batchId, elapsedMs });
  }
}

function usageForResults(results: ReadonlyMap<string, AnthropicBatchItem>) {
  return [...results.values()].reduce((total, item) => ({
    inputTokens: total.inputTokens + (item.result.message?.usage?.input_tokens ?? 0),
    outputTokens: total.outputTokens + (item.result.message?.usage?.output_tokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0 });
}

function addUsage(total: { inputTokens: number; outputTokens: number }, attempt: { inputTokens: number; outputTokens: number }) {
  total.inputTokens += attempt.inputTokens;
  total.outputTokens += attempt.outputTokens;
}

/** Persist intent before create; after an unknown create outcome, recovery requires operator reconciliation. */
export async function createOrResumeBatch(
  runKey: string,
  requests: AnthropicBatchRequest[],
  provider: AnthropicBatchProvider,
  store: BatchRunStateStore,
): Promise<BatchRunState> {
  validateBatchRequests(requests);
  const customIds = requests.map((request) => request.custom_id);
  const requestHash = createHash('sha256').update(JSON.stringify(requests)).digest('hex');
  const prior = await store.get(runKey);
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error('Batch run key reused with different request payload.');
    if (prior.batchId) return prior;
    throw new BatchReconciliationRequiredError('Batch create has no recorded ID; refusing duplicate submission pending reconciliation.');
  }
  const intent: BatchRunState = { runKey, createState: 'creating', customIds, requestHash };
  const claimed = await store.claim(intent);
  if (claimed) {
    if (claimed.requestHash !== requestHash) throw new Error('Batch run key reused with different request payload.');
    if (claimed.batchId) return claimed;
    throw new BatchReconciliationRequiredError('Batch create is already owned or has no recorded ID; refusing duplicate submission pending reconciliation.');
  }
  let created: { id: string; processing_status: AnthropicBatchStatus };
  try { created = await provider.create(requests); }
  catch (error) {
    await store.put({ ...intent, createState: 'outcome_unknown' });
    throw new BatchReconciliationRequiredError(`Anthropic batch create outcome is unknown; reconciliation is required before retry. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!created.id) throw new Error('Anthropic create response omitted batch ID.');
  const accepted = { ...intent, batchId: created.id, createState: 'accepted' as const };
  await store.put(accepted);
  return accepted;
}
