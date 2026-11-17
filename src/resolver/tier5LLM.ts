/**
 * @fileoverview Tier 5 Answer Resolution: LLM Synthesis & QA Bank Writeback.
 * Source Tag: 'ai', resolvedByTier: 5
 */

import {
  LLMSynthesizer,
  classifyTier5Question,
  decideTier5Answer,
  getAnswerSupportQuote,
  getEffectiveFieldOptions,
  getPersistedFieldOptions,
  isRichEeocIdentityQuestion,
  getLlmProviderErrorDiagnostics,
  buildBatchPrompt,
  parseBatchAnswerItems,
  type BatchAnswerItem,
  type BatchQuestion,
  type JobContext,
} from './llmSynthesizer.js';
import config from '../config/env.js';
import { generateFingerprint } from './fingerprint.js';
import { profileRowToCandidateProfile, getCompanyEmail, type ProfileRow } from '../db/profiles.js';
import type { ResolvedField, ScannedField, Tier5ModelAttempt } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  buildQuestionRelevantEvidence,
  isPhoneNumberField,
  supportedCandidatePhoneAnswer,
} from './candidateEvidence.js';
import { getCorporateDefaultHint } from './tier1Supabase.js';
import { recordApplicationTokenUsage } from '../db/tokenUsage.js';
import type { IngestTier5Stages, IngestTier5Work, IngestTier5StageOutcome, IngestTier5StageResult } from './ingestTier5Coordinator.js';
import { createHash } from 'node:crypto';
import { AnthropicBatchPollingAbortedError, BatchReconciliationRequiredError, stableBatchCustomIds } from './anthropicMessageBatch.js';
import type { Tier5BatchProgressState } from './progressTracker.js';

const log = createLogger('Tier 5 LLM');
const REQUIRED_FACTUAL_ACCEPT_CONFIDENCE = 0.70;

type EscalationOutcome = (ResolvedField & { supportQuote?: string }) | {
  result: ResolvedField;
  supportQuote?: string;
  usage?: { promptTokens?: number; completionTokens?: number; cost?: number };
};

export interface CreativeReviewOutcome {
  result: ResolvedField | null;
  approved: boolean;
}

export interface CreativeLengthConstraint {
  wording: string;
  min?: number;
  max?: number;
  unit: 'words' | 'characters';
}

export function getCreativeLengthConstraint(question: string): CreativeLengthConstraint | null {
  const text = question.replace(/,/g, '');
  const range = text.match(/\bbetween\s+(\d+)\s+(words?|characters?)\s+and\s+(\d+)\s+\2\b/i);
  if (range) return { wording: range[0], min: Number(range[1]), max: Number(range[3]), unit: /char/i.test(range[2]) ? 'characters' : 'words' };
  const suffixMax = text.match(/\b(\d+)\s+(words?|characters?)\s+or\s+(?:fewer|less)\b/i);
  if (suffixMax) return { wording: suffixMax[0], max: Number(suffixMax[1]), unit: /char/i.test(suffixMax[2]) ? 'characters' : 'words' };
  const max = text.match(/\b(?:maximum|max(?:imum)? of|no more than|up to|within|under|at most)\s+(\d+)\s+(words?|characters?)\b/i);
  const limited = text.match(/\blimited to\s+(\d+)\s+(words?|characters?)\b/i);
  const maxMatch = max || limited;
  if (maxMatch) return { wording: maxMatch[0], max: Number(maxMatch[1]), unit: /char/i.test(maxMatch[2]) ? 'characters' : 'words' };
  const min = text.match(/\b(?:minimum|min(?:imum)? of|at least)\s+(\d+)\s+(words?|characters?)\b/i);
  if (min) return { wording: min[0], min: Number(min[1]), unit: /char/i.test(min[2]) ? 'characters' : 'words' };
  return null;
}

export function meetsCreativeLengthConstraint(answer: string, constraint: CreativeLengthConstraint | null): boolean {
  if (!constraint) return true;
  const length = constraint.unit === 'words' ? (answer.trim().match(/\S+/g) || []).length : answer.length;
  return (constraint.min === undefined || length >= constraint.min) &&
    (constraint.max === undefined || length <= constraint.max);
}

export type Tier5UsageRecord = { provider: 'anthropic' | 'openrouter'; model: string; batchIds?: readonly string[]; promptTokens?: number; completionTokens?: number; cost?: number };

export function createIngestTier5Stages(
  runKey: string,
  synthesizer = getSynthesizer(),
  onUsage?: (record: Tier5UsageRecord) => void,
  onBatchProgress?: (update: Partial<Tier5BatchProgressState>) => void
): IngestTier5Stages {
  const runStage = async (
    stage: 'haiku' | 'sonnet',
    items: readonly IngestTier5Work[],
    haiku?: ReadonlyMap<string, ResolvedField | null>,
  ): Promise<readonly IngestTier5StageResult[] | IngestTier5StageOutcome> => {
    if (!items.length) return [];
    onBatchProgress?.({
      stage,
      status: 'submitting',
      totalItems: items.length,
      completedItems: 0,
    });
    const questions: BatchQuestion[] = items.map(({ field, profile, resumeText }) => ({
      label: field.label,
      type: field.type,
      options: getEffectiveFieldOptions(field) || field.options,
      optionsComplete: field.optionsComplete,
      candidateEvidence: buildQuestionRelevantEvidence(field, profile, resumeText),
      corporateDefaultHint: (field as any).corporateDefaultHint || getCorporateDefaultHint(field.label, profile) || undefined,
    }));
    const ids = stableBatchCustomIds(`${runKey}:${stage}`, items.map(({ fieldKey }) => fieldKey));
    const prompts = items.map((item, index) => {
      const profile = toCandidateProfile(item.profile);
      const question = questions[index];
      const prompt = stage === 'haiku'
        ? buildBatchPrompt([question], `Role: ${item.jobTitle || 'Position'}\nCompany: ${item.companyName || 'Company'}\nJob posting facts: ${formatJobPostingFacts(item.jobPostingFacts)}`, profile)
        : `Review this required ${classifyTier5Question(item.field)} answer for the job application question. Correct it if needed. Return JSON only as {"answers":[{"answer":"...","confidence":0.0,"supportQuote":"exact evidence quote"}]}. For creative answers write natural first person, preserve the candidate's voice, and invent no candidate facts. Follow the question's explicit length constraint exactly; if correction cannot preserve meaning, return an empty answer. For factual answers require direct evidence and an exact option when the complete choices are listed.\nRole: ${item.jobTitle || '(not provided)'}\nCompany: ${item.companyName || '(not provided)'}\nJob posting facts: ${formatJobPostingFacts(item.jobPostingFacts)}\nOrganization policy/context: ${question.corporateDefaultHint || '(No policy context provided.)'}\nQuestion: ${item.field.label}\nType: ${item.field.type}\nChoices: ${(question.options || []).join(' | ')}\nCandidate evidence:\n${question.candidateEvidence || '(No relevant evidence.)'}\nHaiku answer: ${haiku?.get(item.fieldKey)?.value || '(unresolved)'}`;
      return {
        customId: ids[index],
        prompt,
        system: stage === 'haiku'
          ? 'Answer job application questions from only the supplied candidate evidence. Return one JSON answers array item with answer, confidence, and exact supportQuote. Return an empty answer when unsupported.'
          : 'Review and correct using candidate evidence and supplied organization policy/context. Preserve natural first-person candidate voice, invent no candidate facts, and obey explicit word or character limits exactly. Return an empty answer if correction cannot satisfy the question without changing meaning. Return one JSON answers array item with answer, confidence, and exact supportQuote.',
      };
    });
    let result: Awaited<ReturnType<LLMSynthesizer['runAnthropicPromptBatch']>> | undefined;
    const failedIds = new Set<string>();
    try {
      result = await synthesizer.runAnthropicPromptBatch(
        `${runKey}:${stage}`,
        prompts,
        stage === 'sonnet' ? config.CLAUDE_SONNET_MODEL : synthesizer.getPrimaryModelName(),
        (progress) => {
          onBatchProgress?.({
            stage,
            status: progress.status,
            batchId: progress.batchId,
            totalItems: progress.totalItems ?? items.length,
            completedItems: progress.completedItems ?? 0,
            elapsedMs: progress.elapsedMs,
          });
        }
      );
      onUsage?.({ provider: 'anthropic', model: stage === 'sonnet' ? config.CLAUDE_SONNET_MODEL : synthesizer.getPrimaryModelName(), batchIds: result.batchIds, ...result.usage });
      for (const id of result.failedIds) failedIds.add(id);
    } catch (error) {
      if (error instanceof BatchReconciliationRequiredError) return { results: [], pending: true, reconciliationRequired: true };
      if (error instanceof AnthropicBatchPollingAbortedError) throw error;
      for (const id of ids) failedIds.add(id);
    }
    if (result && result.status !== 'ended') return { results: [], pending: true, batchIds: result.batchIds };
    const malformedIndexes = items.flatMap((_, index) => {
      const raw = result?.responses.get(ids[index]);
      return !failedIds.has(ids[index]) && (!raw || !parseBatchAnswerItems(raw, 1)) ? [index] : [];
    });
    if (malformedIndexes.length) {
      onBatchProgress?.({
        stage: 'retry',
        status: 'submitting',
        totalItems: malformedIndexes.length,
        completedItems: 0,
        details: `${malformedIndexes.length} malformed answers`,
      });
      const retryPrompts = malformedIndexes.map((index) => ({ ...prompts[index], customId: `retry_${ids[index]}` }));
      try {
        const retry = await synthesizer.runAnthropicPromptBatch(
          `${runKey}:${stage}:malformed-retry`,
          retryPrompts,
          stage === 'sonnet' ? config.CLAUDE_SONNET_MODEL : synthesizer.getPrimaryModelName(),
          (progress) => {
            onBatchProgress?.({
              stage: 'retry',
              status: progress.status,
              batchId: progress.batchId,
              totalItems: progress.totalItems ?? malformedIndexes.length,
              completedItems: progress.completedItems ?? 0,
              elapsedMs: progress.elapsedMs,
            });
          }
        );
        onUsage?.({ provider: 'anthropic', model: stage === 'sonnet' ? config.CLAUDE_SONNET_MODEL : synthesizer.getPrimaryModelName(), batchIds: retry.batchIds, ...retry.usage });
        if (retry.status !== 'ended') return { results: [], pending: true, batchIds: [...(result?.batchIds || []), ...retry.batchIds] };
        for (const index of malformedIndexes) {
          const retryId = `retry_${ids[index]}`;
          const raw = retry.responses.get(retryId);
          if (retry.failedIds.has(retryId) || !raw || !parseBatchAnswerItems(raw, 1)) failedIds.add(ids[index]);
          else result!.responses.set(ids[index], raw);
        }
      } catch (error) {
        if (error instanceof BatchReconciliationRequiredError) return { results: [], pending: true, reconciliationRequired: true };
        if (error instanceof AnthropicBatchPollingAbortedError) throw error;
        for (const index of malformedIndexes) failedIds.add(ids[index]);
      }
    }
    const results: IngestTier5StageResult[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const raw = result?.responses.get(ids[index]);
      const parsed: BatchAnswerItem | undefined = raw ? parseBatchAnswerItems(raw, 1)?.[0] : undefined;
      let finalized: ResolvedField | null = null;
      let supportQuote = parsed?.supportQuote || '';
      let confidence = parsed?.confidence;
      let winningModel = stage === 'sonnet' ? config.CLAUDE_SONNET_MODEL : synthesizer.getPrimaryModelName();
      let decisionStage: 'haiku' | 'sonnet' | 'deepseek-flash' | 'deepseek-r1' = stage;
      const evidence = questions[index].candidateEvidence || '';
      const evidenceReference = evidence
        ? `sha256:${createHash('sha256').update(evidence).digest('hex').slice(0, 16)}`
        : undefined;
      const evaluation = (outcome: 'accepted' | 'rejected' | 'missing' | 'unavailable', reason: string) => ({
        fieldKey: item.fieldKey, stage, outcome, reason, supportQuote: supportQuote || undefined, evidenceReference,
      });
      if (failedIds.has(ids[index])) {
        if (config.LLM_PROVIDER === 'openrouter') {
          const fallbackModel = stage === 'haiku' ? config.DEEPSEEK_FLASH_MODEL : config.DEEPSEEK_R1_MODEL;
          const draft = stage === 'sonnet' ? haiku?.get(item.fieldKey)?.value : undefined;
          try {
            const fallback = await synthesizer.synthesizeDeepSeekAnswer(
              item.field,
              toCandidateProfile(item.profile),
              item.resumeText,
              { title: item.jobTitle || 'Position', company: item.companyName || 'Company' },
              item.profile.resume_facts,
              fallbackModel,
              draft,
            );
            onUsage?.({ provider: 'openrouter', model: fallback.usage?.model || fallbackModel, promptTokens: fallback.usage?.promptTokens, completionTokens: fallback.usage?.completionTokens, cost: fallback.usage?.cost });
            finalized = fallback.result;
            supportQuote = fallback.supportQuote || '';
            confidence = fallback.result.confidence;
            winningModel = fallbackModel;
            decisionStage = stage === 'haiku' ? 'deepseek-flash' : 'deepseek-r1';
          } catch {
            finalized = null;
          }
        } else {
          finalized = null;
        }
      } else if (parsed?.answer?.trim()) {
        const profile = toCandidateProfile(item.profile);
        finalized = synthesizer.finalizeRawAnswer(JSON.stringify(parsed), item.field, profile, {
          title: item.jobTitle || 'Position', company: item.companyName || 'Company',
        }, { defaultConfidenceIfMissing: parsed.confidence ?? undefined, allowLowConfidenceCreative: classifyTier5Question(item.field) === 'creative' });
      }
      if (!finalized?.value?.trim()) {
        results.push({ fieldKey: item.fieldKey, answer: null, evaluation: evaluation(failedIds.has(ids[index]) ? 'unavailable' : 'missing', failedIds.has(ids[index]) ? 'provider_fallback_unavailable' : 'empty_answer') });
        continue;
      }
      if (isPhoneNumberField(item.field)) {
        const supportedPhone = supportedCandidatePhoneAnswer(
          finalized.value,
          item.profile,
          item.profile.resume_facts,
          item.resumeText,
        );
        if (!supportedPhone) {
          results.push({ fieldKey: item.fieldKey, answer: null, evaluation: evaluation('rejected', 'phone_not_supported_by_candidate_evidence') });
          continue;
        }
        finalized.value = supportedPhone;
      }
      const decision = decideTier5Answer({
        field: item.field,
        answer: finalized.value,
        evidence,
        supportQuote,
        confidence,
        stage: decisionStage,
        reviewed: stage === 'sonnet' || decisionStage === 'deepseek-r1',
      });
      const creative = classifyTier5Question(item.field) === 'creative';
      const creativeReviewInvalid = creative && !/^(?:i|my|we|our)\b/i.test(finalized.value.trim());
      const lengthConstraint = creative
        ? getCreativeLengthConstraint(item.field.label)
        : null;
      const creativeLengthInvalid = creative && !meetsCreativeLengthConstraint(finalized.value, lengthConstraint);
      const requiredCreativeDraft = stage === 'haiku' && item.field.isRequired &&
        classifyTier5Question(item.field) === 'creative' && decision.reason === 'review_required';
      const rejectionReason = creativeReviewInvalid ? 'creative_answer_not_first_person'
        : creativeLengthInvalid ? 'creative_length_constraint_failed'
          : finalized.source !== 'ai' ? 'answer_source_not_ai'
            : decision.reason;
      if (finalized.source !== 'ai' || (!decision.accepted && !requiredCreativeDraft) || creativeReviewInvalid || creativeLengthInvalid) {
        results.push({ fieldKey: item.fieldKey, answer: null, evaluation: evaluation('rejected', rejectionReason) });
        continue;
      }
      results.push({ fieldKey: item.fieldKey, answer: {
        ...finalized,
        tier5Provenance: {
          fieldKey: item.questionFingerprint,
          winningModel,
          attempts: [{ model: winningModel, status: requiredCreativeDraft ? 'rejected' : 'accepted', confidence: confidence ?? undefined }],
        },
      }, evaluation: evaluation(requiredCreativeDraft ? 'rejected' : 'accepted', decision.reason) });
    }
    const acceptedCount = results.filter((r) => r.answer !== null).length;
    const failedCount = results.length - acceptedCount;
    onBatchProgress?.({
      stage,
      status: 'completed',
      totalItems: items.length,
      completedItems: items.length,
      acceptedCount,
      failedCount,
    });
    return results;
  };
  return {
    haiku: (items) => runStage('haiku', items),
    sonnet: (items, haiku) => runStage('sonnet', items, haiku),
  };
}

function formatJobPostingFacts(facts: IngestTier5Work['jobPostingFacts']): string {
  if (!facts) return '(No scanned job posting facts.)';
  const location = facts.location || (facts.locations?.length ? facts.locations.join(', ') : undefined);
  const raw = facts.raw
    ? Object.entries(facts.raw).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => `${key}: ${value}`).join('; ')
    : '';
  return [location && `Location: ${location}`, raw && `Other scanned facts: ${raw}`].filter(Boolean).join('\n') || '(No scanned job posting facts.)';
}

/** Shared fail-closed validator used by Tier 5 single and batch paths. */
export async function finalizeTier5WithEscalation(
  field: ScannedField,
  primary: ResolvedField | null,
  escalate: () => Promise<EscalationOutcome | null>,
  options: {
    primaryModel?: string;
    fieldKey?: string;
    evidence?: string;
    primarySupportQuote?: string;
    reviewRequiredCreative?: (draft: ResolvedField, evidence: string) => Promise<CreativeReviewOutcome>;
  } = {}
): Promise<ResolvedField | null> {
  const fieldKey = options.fieldKey || generateFingerprint(field.label, field.type);
  const choices = field.options?.length ? field.options : undefined;
  const exactChoiceValid = (candidate: ResolvedField | null): candidate is ResolvedField => {
    if (!candidate || candidate.source !== 'ai' || !candidate.value?.trim()) return false;
    if (field.optionsComplete === false || !choices || !['select', 'radio', 'checkbox'].includes(field.type)) return true;
    return choices.some((option) => option.trim().toLowerCase() === candidate.value.trim().toLowerCase());
  };
  const attempts: Tier5ModelAttempt[] = [];
  const primaryModel = primary?.tier5Provenance?.winningModel || options.primaryModel || 'claude-haiku-5-5';
  const primaryValid = exactChoiceValid(primary);
  const primaryConfidence = primaryValid ? primary.confidence : 0;
  const kind = classifyTier5Question(field);
  const primaryDecision = decideTier5Answer({
    field, answer: primaryValid ? primary.value : '', evidence: options.evidence || '',
    supportQuote: options.primarySupportQuote,
    confidence: primaryValid ? primary.confidence : null, stage: 'haiku',
  });
  attempts.push({
    model: primaryModel,
    status: primaryValid && primaryDecision.accepted && (kind === 'creative' || primaryConfidence >= REQUIRED_FACTUAL_ACCEPT_CONFIDENCE) ? 'accepted' : 'rejected',
    confidence: primaryValid ? primaryConfidence : undefined,
  });
  if (primaryValid && kind === 'creative' && !field.isRequired && primaryDecision.accepted) {
    return {
      ...primary,
      tier5Provenance: { fieldKey, winningModel: primaryModel, attempts },
    };
  }

  if (primaryValid && kind !== 'creative' && primaryDecision.accepted && primaryConfidence >= REQUIRED_FACTUAL_ACCEPT_CONFIDENCE) {
    return { ...primary, tier5Provenance: { fieldKey, winningModel: primaryModel, attempts } };
  }

  if (!field.isRequired) return null;

  if (kind === 'creative') {
    if (!primaryValid || !options.reviewRequiredCreative) return null;
    try {
      const review = await options.reviewRequiredCreative(primary, options.evidence || '');
      const reviewedResult = review.result;
      if (!review.approved || !exactChoiceValid(reviewedResult) || !/^(?:i|my|we|our)\b/i.test(reviewedResult.value.trim())) return null;
      const reviewedDecision = decideTier5Answer({
        field, answer: reviewedResult.value, evidence: options.evidence || '',
        confidence: reviewedResult.confidence, stage: 'sonnet', reviewed: true,
      });
      if (!reviewedDecision.accepted) return null;
      attempts.push({
        model: reviewedResult.tier5Provenance?.winningModel || 'claude-sonnet-review',
        status: 'accepted', confidence: reviewedResult.confidence,
      });
      return { ...reviewedResult, tier5Provenance: {
        fieldKey, winningModel: reviewedResult.tier5Provenance?.winningModel || 'claude-sonnet-review', attempts,
      } };
    } catch (error) {
      attempts.push({ model: 'claude-sonnet-review', status: 'error', error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  const deepSeekModel = 'deepseek/deepseek-r1-0528';
  try {
    const escalated = await escalate();
    const secondary = escalated && 'result' in escalated ? escalated.result : escalated;
    const usage = escalated && 'result' in escalated ? escalated.usage : undefined;
    const supportQuote = escalated && 'result' in escalated ? escalated.supportQuote : escalated?.supportQuote;
    const secondaryValid = exactChoiceValid(secondary);
    const confidence = secondaryValid ? secondary.confidence : 0;
    const secondaryDecision = decideTier5Answer({
      field, answer: secondaryValid ? secondary.value : '', evidence: options.evidence || '', confidence,
      supportQuote,
      stage: 'deepseek-r1',
    });
    const accepted = secondaryValid && secondaryDecision.accepted && Number.isFinite(confidence) && confidence >= REQUIRED_FACTUAL_ACCEPT_CONFIDENCE;
    attempts.push({
      model: deepSeekModel,
      status: accepted ? 'accepted' : 'rejected',
      confidence: secondaryValid ? confidence : undefined,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      cost: usage?.cost,
    });
    if (!accepted || !secondary) return null;
    return {
      ...secondary,
      tier5Provenance: { fieldKey, winningModel: deepSeekModel, attempts },
    };
  } catch (error) {
    attempts.push({
      model: deepSeekModel,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export type LlmFailureReason = 'timeout' | 'rate_limit' | 'server_error' | 'permanent';

export interface LlmFailureInfo {
  reason: LlmFailureReason;
  isRetriable: boolean;
  message: string;
  statusCode?: number;
  errorName?: string;
  errorCode?: string;
  errorType?: string;
  requestId?: string;
  parameter?: string;
  retryAfter?: string;
  timestamp: number;
}

export function classifyLlmError(err: unknown): LlmFailureInfo {
  const details = getLlmProviderErrorDiagnostics(err);
  const message = details.message;
  const status = details.statusCode;

  let reason: LlmFailureReason = 'permanent';
  let isRetriable = false;

  if (
    status === 429 ||
    /429|rate\s*limit|quota|too\s*many\s*requests|ThrottlingException/i.test(message) ||
    details.errorCode === 'ThrottlingException'
  ) {
    reason = 'rate_limit';
    isRetriable = true;
  } else if (
    (typeof status === 'number' && status >= 500 && status < 600) ||
    /5\d\d|bad\s*gateway|gateway\s*timeout|service\s*unavailable|internal\s*server\s*error|ServiceUnavailableException|InternalServerException/i.test(message) ||
    details.errorCode === 'ServiceUnavailableException' ||
    details.errorCode === 'InternalServerException'
  ) {
    reason = 'server_error';
    isRetriable = true;
  } else if (
    /timeout|timed\s*out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ESOCKETTIMEDOUT|AbortError|ModelTimeoutException/i.test(message) ||
    details.errorCode === 'ModelTimeoutException' ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'TimeoutError') ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError')
  ) {
    reason = 'timeout';
    isRetriable = true;
  }

  return {
    reason,
    isRetriable,
    message,
    statusCode: status,
    errorName: details.errorName,
    errorCode: details.errorCode,
    errorType: details.errorType,
    requestId: details.requestId,
    parameter: details.parameter,
    retryAfter: details.retryAfter,
    timestamp: Date.now(),
  };
}

let synthesizerInstance: LLMSynthesizer | null = null;

let sessionLlmCost = 0;
let sessionPromptTokens = 0;
let sessionCompletionTokens = 0;

export function getSessionLlmMetrics() {
  return {
    cost: sessionLlmCost,
    promptTokens: sessionPromptTokens,
    completionTokens: sessionCompletionTokens,
  };
}

export function resetSessionLlmMetrics() {
  sessionLlmCost = 0;
  sessionPromptTokens = 0;
  sessionCompletionTokens = 0;
}

function getSynthesizer(): LLMSynthesizer {
  if (!synthesizerInstance) {
    synthesizerInstance = new LLMSynthesizer();
  }
  return synthesizerInstance;
}

/**
 * Transforms ProfileRow into ApplyWizzCandidateProfile for LLMSynthesizer compatibility.
 */
function toCandidateProfile(profile: ProfileRow) {
  return {
    ...profileRowToCandidateProfile(profile),
    raw_api_payload: profile.raw_api_payload ?? undefined,
  };
}

function isSandboxLlmAnsweringDisabled(): boolean {
  const isSandbox = process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
  return isSandbox && String(process.env.LLM_ANSWERING).trim().toLowerCase() === 'false';
}

/**
 * Attempts Tier 5 resolution using strict Anthropic Claude LLM synthesis.
 * Automatically writes the synthesized answer to `candidate_qa_bank` with source: 'ai'.
 *
 * @returns ResolvedField with source: 'ai', resolvedByTier: 5, or null if synthesis fails.
 */
export async function resolveTier5(
  applywizzId: string,
  field: ScannedField,
  candidateProfile: ProfileRow,
  jobContext: { companyName: string; jobTitle: string },
  resumeText: string = ''
): Promise<ResolvedField | null> {
  if (isSandboxLlmAnsweringDisabled()) {
    log.debug(`[Resolver] 🛑 Sandbox LLM answering disabled (LLM_ANSWERING=false) — skipping T5 for ${field.label}`);
    return null;
  }

  const synthesizer = getSynthesizer();
  const context: JobContext = {
    title: jobContext.jobTitle || 'Position',
    company: jobContext.companyName || 'Company',
  };

  if (
    (field.type === 'radio' || field.type === 'select') &&
    (!field.options || field.options.length === 0) &&
    isRichEeocIdentityQuestion(field)
  ) {
    return null;
  }

  const adaptedProfile = toCandidateProfile(candidateProfile);
  const effectiveOptions = getEffectiveFieldOptions(field);
  const fieldForLlm: ScannedField =
    effectiveOptions && (!field.options || field.options.length === 0)
      ? { ...field, options: effectiveOptions }
      : field;
  const fingerprint = generateFingerprint(field.label, field.type);
  const combined = `${field.label || ''} ${field.name || ''} ${field.fieldId || ''}`;

  // Email fields must never be LLM-synthesized — use company email only
  if (/email/i.test(combined)) {
    const compEmail = getCompanyEmail(candidateProfile);
    if (compEmail) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: compEmail,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired: Boolean(field.isRequired),
      };
    }
    return null;
  }

  const requestStartedAt = Date.now();
  try {
    const resumeFacts =
      (candidateProfile as { resume_facts?: Record<string, unknown> }).resume_facts ||
      (candidateProfile.work_experience || candidateProfile.education
        ? { experience: candidateProfile.work_experience, education: candidateProfile.education }
        : undefined);

    const rawResult = await synthesizer.synthesizeAnswer(
      fieldForLlm,
      adaptedProfile,
      resumeText,
      context,
      resumeFacts
    );

    const primary = rawResult?.source === 'unresolved' ? null : rawResult;
    const finalized = await finalizeTier5WithEscalation(
      fieldForLlm,
      primary,
      async () => synthesizer.synthesizeDeepSeekAnswer(fieldForLlm, adaptedProfile, resumeText, context, resumeFacts),
      {
        primaryModel: synthesizer.getPrimaryModelName(), fieldKey: fingerprint,
      primarySupportQuote: getAnswerSupportQuote(primary),
        evidence: buildQuestionRelevantEvidence(fieldForLlm, adaptedProfile, resumeText, resumeFacts),
      }
    );
    if (finalized?.value?.trim()) {
      const confidence = finalized.confidence ?? 0;
      if (isPhoneNumberField(field)) {
        const supportedPhone = supportedCandidatePhoneAnswer(finalized.value, adaptedProfile, resumeFacts, resumeText);
        if (!supportedPhone) {
          log.warn('[Resolver] T5 phone answer rejected: unsupported_or_conflicting_candidate_evidence');
          return null;
        }
        finalized.value = supportedPhone;
      }

      const resolvedField: ResolvedField = {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalized.value.trim(),
        source: 'ai',
        resolvedByTier: 5,
        confidence,
        isRequired: Boolean(field.isRequired),
        ...(getPersistedFieldOptions(field) ? { options: getPersistedFieldOptions(field) } : {}),
        tier5Provenance: finalized.tier5Provenance,
      };

      return resolvedField;
    }
  } catch (err: unknown) {
    const failure = classifyLlmError(err);
    const details = formatLlmFailure(failure);
    log.error(
      `[Resolver] event=t5_provider_failure candidate=${applywizzId} operation=single ` +
        `field_fingerprint=${fingerprint} provider=${synthesizer.getProviderDiagnostics().provider} ` +
        `model=${synthesizer.getProviderDiagnostics().model} reason=${failure.reason} ` +
        `retryable=${failure.isRetriable} elapsed_ms=${Date.now() - requestStartedAt} ${details}`
    );
  }

  return null;
}

/** Max LLM fields per batch API call within one candidate×job resolution. */
export const TIER5_BATCH_CHUNK_SIZE = 8;

/**
 * Tier 5 batch path: one LLM request per chunk, with the same post-validation as single-field synthesis.
 */
export async function resolveTier5Batch(
  applywizzId: string,
  fields: ScannedField[],
  candidateProfile: ProfileRow,
  jobContext: { companyName: string; jobTitle: string; jobUrl?: string; role?: string },
  resumeText: string = '',
  jobDescription: string = ''
): Promise<(ResolvedField | null)[]> {
  if (fields.length === 0) return [];
  if (isSandboxLlmAnsweringDisabled()) {
    log.debug(`[Resolver] 🛑 Sandbox LLM answering disabled (LLM_ANSWERING=false) — skipping T5 batch for ${fields.length} fields`);
    return new Array(fields.length).fill(null);
  }

  const synthesizer = getSynthesizer();
  const context: JobContext = {
    title: jobContext.jobTitle || 'Position',
    company: jobContext.companyName || 'Company',
  };
  const adaptedProfile = toCandidateProfile(candidateProfile);
  const jd =
    jobDescription.trim() ||
    `Role: ${context.title}\nCompany: ${context.company}`;

  const results: (ResolvedField | null)[] = new Array(fields.length).fill(null);
  const llmFields: ScannedField[] = [];
  const llmIndices: number[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const combined = `${field.label || ''} ${field.name || ''} ${field.fieldId || ''}`;
    if (
      (field.type === 'radio' || field.type === 'select') &&
      (!field.options || field.options.length === 0) &&
      isRichEeocIdentityQuestion(field)
    ) {
      continue;
    }
    if (/email/i.test(combined)) {
      const compEmail = getCompanyEmail(candidateProfile);
      if (compEmail) {
        results[i] = {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: compEmail,
          source: 'supabase',
          resolvedByTier: 1,
          confidence: 1.0,
          isRequired: Boolean(field.isRequired),
        };
      }
      continue;
    }
    llmFields.push(field);
    llmIndices.push(i);
  }

  if (llmFields.length === 0) return results;

  try {
    const startedAt = Date.now();
    const batchQuestions: BatchQuestion[] = llmFields.map((field) => {
      const effectiveOptions = getEffectiveFieldOptions(field);
      const corporateDefaultHint =
        (field as any).corporateDefaultHint ||
        getCorporateDefaultHint(field.label, candidateProfile) ||
        undefined;
      return {
        label: field.label,
        type: field.type,
        options: effectiveOptions || (field.optionsComplete === false ? field.options : undefined),
        optionsComplete: field.optionsComplete,
        candidateEvidence: buildQuestionRelevantEvidence(field, candidateProfile, resumeText),
        corporateDefaultHint,
      };
    });

    const evidenceFields = batchQuestions.filter((question) => question.candidateEvidence?.trim()).length;
    const optionCount = batchQuestions.reduce(
      (total, question) => total + (question.options?.length ?? 0),
      0
    );
    log.debug(`[LLM] evidence_fields=${evidenceFields} options=${optionCount}`);

    const batchResult = await synthesizer.synthesizeBatchAnswers(
      batchQuestions,
      resumeText,
      jd,
      adaptedProfile
    );
    const rawAnswers = batchResult.answers;
    const resolvedCount = rawAnswers.filter((answer) => Boolean(answer?.trim())).length;
    log.debug(
      `[Resolver] event=t5_batch_result candidate=${applywizzId} batch_size=${llmFields.length} ` +
        `provider=${synthesizer.getProviderDiagnostics().provider} model=${synthesizer.getProviderDiagnostics().model} ` +
        `nonempty_answers=${resolvedCount} elapsed_ms=${Date.now() - startedAt}`
    );

    // Record token usage if available and jobUrl is present
    if (batchResult.usage && jobContext.jobUrl) {
      const callCost = batchResult.usage.cost ?? 0;
      sessionLlmCost += callCost;
      sessionPromptTokens += batchResult.usage.promptTokens ?? 0;
      sessionCompletionTokens += batchResult.usage.completionTokens ?? 0;

      recordApplicationTokenUsage({
        applywizzId,
        jobUrl: jobContext.jobUrl,
        role: jobContext.role || jobContext.jobTitle || 'Position',
        model: batchResult.usage.model,
        promptTokens: batchResult.usage.promptTokens,
        completionTokens: batchResult.usage.completionTokens,
        cacheReadTokens: batchResult.usage.cacheReadTokens,
        cacheWriteTokens: batchResult.usage.cacheWriteTokens,
        cost: batchResult.usage.cost,
        metadata: {
          fieldCount: llmFields.length,
          resolvedCount,
        },
      }).catch((err) => {
        log.warn(`[Token Usage] Failed to record usage: ${err?.message}`);
      });
    }

    for (let j = 0; j < llmFields.length; j++) {
      const field = llmFields[j];
      const effectiveOptions = getEffectiveFieldOptions(field);
      const fieldForLlm: ScannedField =
        effectiveOptions && (!field.options || field.options.length === 0)
          ? { ...field, options: effectiveOptions }
          : field;
      const fingerprint = generateFingerprint(field.label, field.type);
      const raw = rawAnswers[j] ?? '';
      const rawConf = batchResult.confidences?.[j];

      const primary = synthesizer.finalizeRawAnswer(raw, fieldForLlm, adaptedProfile, context, {
        defaultConfidenceIfMissing: rawConf,
      });
      const finalized = await finalizeTier5WithEscalation(
        fieldForLlm,
        primary.source === 'unresolved' ? null : primary,
        async () => synthesizer.synthesizeDeepSeekAnswer(
          fieldForLlm,
          adaptedProfile,
          resumeText,
          context,
          candidateProfile.resume_facts
        ),
        {
          primaryModel: synthesizer.getPrimaryModelName(), fieldKey: fingerprint,
          primarySupportQuote: batchResult.supportQuotes?.[j],
          evidence: batchQuestions[j]?.candidateEvidence || '',
        }
      );
      if (!finalized?.value?.trim()) continue;
      const confidence = finalized.confidence ?? 0;
      const supportedPhone = isPhoneNumberField(field)
        ? supportedCandidatePhoneAnswer(
            finalized.value,
            candidateProfile,
            candidateProfile.resume_facts,
            resumeText
          )
        : null;
      if (isPhoneNumberField(field) && !supportedPhone) {
        log.warn('[Resolver] T5 phone answer rejected: unsupported_or_conflicting_candidate_evidence');
        continue;
      }

      const resolvedField: ResolvedField = {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: supportedPhone || finalized.value.trim(),
        source: 'ai',
        resolvedByTier: 5,
        confidence,
        isRequired: Boolean(field.isRequired),
        ...(getPersistedFieldOptions(field) ? { options: getPersistedFieldOptions(field) } : {}),
        tier5Provenance: finalized.tier5Provenance,
      };

      results[llmIndices[j]] = resolvedField;
    }
  } catch (err: unknown) {
    const failure = classifyLlmError(err);
    log.error(
      `[Resolver] event=t5_batch_provider_failure candidate=${applywizzId} ` +
        `batch_size=${llmFields.length} provider=${synthesizer.getProviderDiagnostics().provider} ` +
        `model=${synthesizer.getProviderDiagnostics().model} reason=${failure.reason} ` +
        `retryable=${failure.isRetriable} ${formatLlmFailure(failure)}`
    );
  }

  return results;
}

function formatLlmFailure(failure: LlmFailureInfo): string {
  return [
    failure.statusCode !== undefined ? `http_status=${failure.statusCode}` : undefined,
    failure.errorName ? `error_name=${failure.errorName}` : undefined,
    failure.errorCode ? `error_code=${failure.errorCode}` : undefined,
    failure.errorType ? `error_type=${failure.errorType}` : undefined,
    failure.parameter ? `parameter=${failure.parameter}` : undefined,
    failure.requestId ? `request_id=${failure.requestId}` : undefined,
    failure.retryAfter ? `retry_after=${failure.retryAfter}` : undefined,
    failure.message ? `message="${failure.message}"` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

export default resolveTier5;
