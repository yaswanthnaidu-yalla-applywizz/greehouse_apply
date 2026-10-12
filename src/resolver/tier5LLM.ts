/**
 * @fileoverview Tier 5 Answer Resolution: LLM Synthesis & QA Bank Writeback.
 * Source Tag: 'ai', resolvedByTier: 5
 */

import {
  LLMSynthesizer,
  LLM_MIN_CONFIDENCE,
  getEffectiveFieldOptions,
  isRichEeocIdentityQuestion,
  getLlmProviderErrorDiagnostics,
  type BatchQuestion,
  type JobContext,
} from './llmSynthesizer.js';
import { upsertAnswer } from '../db/qaBank.js';
import { generateFingerprint } from './fingerprint.js';
import { writeEmbedding } from './semanticSearch.js';
import { profileRowToCandidateProfile, getCompanyEmail, type ProfileRow } from '../db/profiles.js';
import type { ResolvedField, ScannedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  buildQuestionRelevantEvidence,
  isPhoneNumberField,
  resumeAnswerMatchesPhone,
} from './candidateEvidence.js';
import { getCorporateDefaultHint } from './tier1Supabase.js';
import { recordApplicationTokenUsage } from '../db/tokenUsage.js';

const log = createLogger('Tier 5 LLM');

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

/**
 * Attempts Tier 5 resolution using LLM synthesis (Gemini/OpenRouter/OpenAI).
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

    if (rawResult && rawResult.source === 'unresolved') {
      return null;
    }

    const confidence = rawResult?.confidence ?? 0;
    if (rawResult && rawResult.value && rawResult.value.trim().length > 0) {
      if (confidence < LLM_MIN_CONFIDENCE) {
        return null;
      }
      if (isPhoneNumberField(field)) {
        const resumePhone = resumeAnswerMatchesPhone(rawResult.value, resumeFacts, resumeText);
        if (!resumePhone) {
          log.warn(`[Resolver] Γ¥î T5 phone answer not verified against resume for candidate ${applywizzId} (${field.label}): "${rawResult.value}"`);
          return null;
        }
        rawResult.value = resumePhone;
      }

      const resolvedField: ResolvedField = {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: rawResult.value.trim(),
        source: 'ai',
        resolvedByTier: 5,
        confidence,
        isRequired: Boolean(field.isRequired),
        ...(effectiveOptions ? { options: effectiveOptions } : {}),
      };

      // Write-back to persistent candidate QA bank
      try {
        await upsertAnswer({
          applywizz_id: applywizzId,
          question_fingerprint: fingerprint,
          question_label: field.label,
          field_type: field.type,
          value: resolvedField.value,
          source: 'ai',
          confidence: resolvedField.confidence,
        });
        await writeEmbedding(applywizzId, fingerprint, field.label);
      } catch {
        // Ignore QA bank writeback error
      }

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

      const finalized = synthesizer.finalizeRawAnswer(raw, fieldForLlm, adaptedProfile, context, {
        defaultConfidenceIfMissing: 0.85,
      });

      if (finalized.source === 'unresolved' || !finalized.value?.trim()) {
        continue;
      }

      const confidence = finalized.confidence ?? 0;
      if (confidence < LLM_MIN_CONFIDENCE) {
        continue;
      }
      const resumePhone = isPhoneNumberField(field)
        ? resumeAnswerMatchesPhone(
            finalized.value,
            candidateProfile.resume_facts,
            resumeText
          )
        : null;
      if (isPhoneNumberField(field) && !resumePhone) {
        log.warn(`[Resolver] Γ¥î T5 phone answer not verified against resume for candidate ${applywizzId} (${field.label}): "${finalized.value}"`);
        continue;
      }

      const resolvedField: ResolvedField = {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: resumePhone || finalized.value.trim(),
        source: 'ai',
        resolvedByTier: 5,
        confidence,
        isRequired: Boolean(field.isRequired),
        ...(effectiveOptions ? { options: effectiveOptions } : {}),
      };

      try {
        await upsertAnswer({
          applywizz_id: applywizzId,
          question_fingerprint: fingerprint,
          question_label: field.label,
          field_type: field.type,
          value: resolvedField.value,
          source: 'ai',
          confidence: resolvedField.confidence,
        });
        await writeEmbedding(applywizzId, fingerprint, field.label);
      } catch {
        // Ignore QA bank writeback error
      }

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
