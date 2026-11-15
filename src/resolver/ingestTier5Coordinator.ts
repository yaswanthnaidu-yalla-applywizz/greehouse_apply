import type { JobPostingFacts, ResolvedField, ScannedField } from '../types/index.js';
import { classifyTier5Question } from './llmSynthesizer.js';
import type { ProfileRow } from '../db/profiles.js';
import { generateFingerprint } from './fingerprint.js';
import { AnthropicBatchPollingAbortedError } from './anthropicMessageBatch.js';

export interface IngestTier5Work {
  candidateId: string;
  jobUrl: string;
  taskId?: string | null;
  assignmentOrdinal?: number;
  fieldKey: string;
  field: ScannedField;
  original: ResolvedField;
  profile: ProfileRow;
  resumeText: string;
  jobTitle: string;
  companyName: string;
  jobPostingFacts?: JobPostingFacts;
  questionFingerprint: string;
}

export interface IngestTier5StageResult {
  fieldKey: string;
  answer: ResolvedField | null;
  evaluation?: IngestTier5StageDecision;
}

export interface IngestTier5StageDecision {
  fieldKey: string;
  stage: 'haiku' | 'sonnet';
  outcome: 'accepted' | 'rejected' | 'missing' | 'unavailable';
  reason: string;
  /** Model-asserted support text. It has not been independently verified. */
  supportQuote?: string;
  evidenceReference?: string;
}

export type IngestTier5EvaluationCallback = (decision: IngestTier5StageDecision) => void;

export interface IngestTier5Stages {
  haiku(items: readonly IngestTier5Work[]): Promise<readonly IngestTier5StageResult[] | IngestTier5StageOutcome>;
  sonnet(items: readonly IngestTier5Work[], haiku: ReadonlyMap<string, ResolvedField | null>): Promise<readonly IngestTier5StageResult[] | IngestTier5StageOutcome>;
}

export interface IngestTier5StageOutcome {
  results: readonly IngestTier5StageResult[];
  pending?: boolean;
  batchIds?: readonly string[];
  reconciliationRequired?: boolean;
}

export class IngestTier5BatchPendingError extends Error {
  constructor(readonly stage: 'haiku' | 'sonnet', readonly batchIds: readonly string[]) {
    super(`Tier 5 ${stage} batch is still processing; application finalization is blocked.`);
    this.name = 'IngestTier5BatchPendingError';
  }
}

export class IngestTier5ReconciliationRequiredError extends Error {
  constructor() {
    super('Tier 5 batch outcome requires reconciliation; application finalization is blocked.');
    this.name = 'IngestTier5ReconciliationRequiredError';
  }
}

export function preserveNewerAuthoritativeAnswers(
  proposed: readonly ResolvedField[],
  existing: readonly ResolvedField[] | null | undefined,
): ResolvedField[] {
  if (!existing?.length) return [...proposed];
  return proposed.map((field) => {
    const fingerprint = generateFingerprint(field.label, field.type);
    const current = existing.find((candidate) =>
      candidate.fieldId === field.fieldId &&
      generateFingerprint(candidate.label, candidate.type) === fingerprint &&
      Boolean(candidate.value?.trim()) && candidate.source !== 'ai' && candidate.source !== 'unresolved'
    );
    return current ? {
      ...field,
      ...current,
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      isRequired: field.isRequired,
      options: field.options ?? current.options,
      optionsComplete: field.optionsComplete ?? current.optionsComplete,
      metadata: { ...field.metadata, ...current.metadata },
    } : field;
  });
}

export interface IngestTier5StageFactory {
  haiku(items: readonly IngestTier5Work[]): Promise<readonly IngestTier5StageResult[]>;
  sonnet(items: readonly IngestTier5Work[], haiku: ReadonlyMap<string, ResolvedField | null>): Promise<readonly IngestTier5StageResult[]>;
}

/** Keeps provider output keyed to its original candidate/job/field slot. */
export async function resolveIngestTier5(
  work: readonly IngestTier5Work[],
  stages: IngestTier5Stages,
  onEvaluation?: IngestTier5EvaluationCallback,
): Promise<Map<string, ResolvedField>> {
  const unique = new Map<string, IngestTier5Work>();
  for (const item of work) {
    if (!item.fieldKey) throw new Error('Ingest Tier 5 field key is required.');
    const prior = unique.get(item.fieldKey);
    if (prior) {
      const sameQuestion = prior.candidateId.toUpperCase() === item.candidateId.toUpperCase() &&
        prior.jobUrl === item.jobUrl && prior.questionFingerprint === item.questionFingerprint &&
        prior.field.fieldId === item.field.fieldId && prior.field.label === item.field.label && prior.field.type === item.field.type;
      if (sameQuestion) continue;
      throw new Error(`Conflicting ingest Tier 5 field key: ${item.fieldKey}`);
    }
    unique.set(item.fieldKey, item);
  }
  const keyed = [...unique.values()].sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
  if (!keyed.length) return new Map();

  let haiku = new Map<string, ResolvedField | null>();
  let haikuOutcome: readonly IngestTier5StageResult[] | IngestTier5StageOutcome = [];
  let haikuFailureReason: string | undefined;
  try { haikuOutcome = await stages.haiku(keyed); }
  catch (error) {
    if (error instanceof IngestTier5ReconciliationRequiredError) throw error;
    if (error instanceof AnthropicBatchPollingAbortedError) throw error;
    /* Provider failure leaves these required answers unresolved for escalation. */
    haikuFailureReason = 'provider_exception';
  }
  if (!Array.isArray(haikuOutcome) && (haikuOutcome as IngestTier5StageOutcome).reconciliationRequired) {
    reportStageDecisions(keyed, (haikuOutcome as IngestTier5StageOutcome).results, 'haiku', onEvaluation, 'reconciliation_required');
    throw new IngestTier5ReconciliationRequiredError();
  }
  const haikuResults = Array.isArray(haikuOutcome) ? haikuOutcome : (haikuOutcome as IngestTier5StageOutcome).results;
  const haikuPending = !Array.isArray(haikuOutcome) && (haikuOutcome as IngestTier5StageOutcome).pending;
  reportStageDecisions(keyed, haikuResults, 'haiku', onEvaluation, haikuPending ? 'batch_pending' : haikuFailureReason);
  haiku = validateStageResults(keyed, haikuResults);
  if (haikuPending) {
    throw new IngestTier5BatchPendingError('haiku', (haikuOutcome as IngestTier5StageOutcome).batchIds || []);
  }
  const escalation = keyed.filter((item) => item.field.isRequired &&
    (classifyTier5Question(item.field) === 'creative' || !isAccepted(item, haiku.get(item.fieldKey))));
  let sonnet = new Map<string, ResolvedField | null>();
  if (escalation.length) {
    let sonnetOutcome: readonly IngestTier5StageResult[] | IngestTier5StageOutcome = [];
    let sonnetFailureReason: string | undefined;
    try { sonnetOutcome = await stages.sonnet(escalation, haiku); }
    catch (error) {
      if (error instanceof IngestTier5ReconciliationRequiredError) throw error;
      if (error instanceof AnthropicBatchPollingAbortedError) throw error;
      /* Provider failure leaves required answers unresolved. */
      sonnetFailureReason = 'provider_exception';
    }
    if (!Array.isArray(sonnetOutcome) && (sonnetOutcome as IngestTier5StageOutcome).reconciliationRequired) {
      reportStageDecisions(escalation, (sonnetOutcome as IngestTier5StageOutcome).results, 'sonnet', onEvaluation, 'reconciliation_required');
      throw new IngestTier5ReconciliationRequiredError();
    }
    const sonnetResults = Array.isArray(sonnetOutcome) ? sonnetOutcome : (sonnetOutcome as IngestTier5StageOutcome).results;
    const sonnetPending = !Array.isArray(sonnetOutcome) && (sonnetOutcome as IngestTier5StageOutcome).pending;
    reportStageDecisions(escalation, sonnetResults, 'sonnet', onEvaluation, sonnetPending ? 'batch_pending' : sonnetFailureReason);
    if (sonnetPending) {
      throw new IngestTier5BatchPendingError('sonnet', (sonnetOutcome as IngestTier5StageOutcome).batchIds || []);
    }
    sonnet = validateStageResults(escalation, sonnetResults);
  }

  const accepted = new Map<string, ResolvedField>();
  for (const item of keyed) {
    const creative = classifyTier5Question(item.field) === 'creative';
    const answer = item.field.isRequired && creative
      ? sonnet.get(item.fieldKey)
      : isAccepted(item, haiku.get(item.fieldKey)) ? haiku.get(item.fieldKey) : sonnet.get(item.fieldKey);
    if (answer && isAccepted(item, answer)) {
      const primaryAttempts = haiku.get(item.fieldKey)?.tier5Provenance?.attempts || [];
      const finalAttempts = answer.tier5Provenance?.attempts || [];
      const provenance = {
        fieldKey: item.questionFingerprint || generateFingerprint(item.field.label, item.field.type),
        winningModel: answer.tier5Provenance?.winningModel || 'unknown',
        attempts: [...primaryAttempts, ...finalAttempts],
      };
      accepted.set(item.fieldKey, { ...answer, tier5Provenance: provenance, fieldId: item.field.fieldId, name: item.field.name, type: item.field.type, label: item.field.label, isRequired: Boolean(item.field.isRequired) });
    }
  }
  return accepted;
}

function reportStageDecisions(
  requested: readonly IngestTier5Work[],
  results: readonly IngestTier5StageResult[],
  stage: 'haiku' | 'sonnet',
  callback?: IngestTier5EvaluationCallback,
  unavailableReason?: string,
): void {
  if (!callback) return;
  const byKey = new Map(results.map((result) => [result.fieldKey, result]));
  for (const item of requested) {
    const result = byKey.get(item.fieldKey);
    callback(result?.evaluation || (unavailableReason ? {
      fieldKey: item.fieldKey,
      stage,
      outcome: 'unavailable',
      reason: unavailableReason,
    } : {
      fieldKey: item.fieldKey,
      stage,
      outcome: 'missing',
      reason: result ? 'stage_result_without_decision' : 'stage_result_omitted',
    }));
  }
}

function validateStageResults(
  requested: readonly IngestTier5Work[],
  results: readonly IngestTier5StageResult[],
): Map<string, ResolvedField | null> {
  const expected = new Set(requested.map((item) => item.fieldKey));
  const output = new Map<string, ResolvedField | null>();
  for (const result of results) {
    if (!expected.has(result.fieldKey) || output.has(result.fieldKey)) throw new Error(`Unexpected or duplicate Tier 5 result: ${result.fieldKey}`);
    output.set(result.fieldKey, result.answer);
  }
  for (const key of expected) if (!output.has(key)) output.set(key, null);
  return output;
}

function isAccepted(item: IngestTier5Work, answer: ResolvedField | null | undefined): answer is ResolvedField {
  return Boolean(answer && answer.source === 'ai' && answer.value.trim() &&
    (classifyTier5Question(item.field) === 'creative' ||
      (Number.isFinite(answer.confidence) && answer.confidence >= 0.70)));
}
