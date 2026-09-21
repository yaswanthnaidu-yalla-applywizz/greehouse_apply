/**
 * @fileoverview Tier 5 Answer Resolution: LLM Synthesis & QA Bank Writeback.
 * Source Tag: 'ai', resolvedByTier: 5
 */

import {
  LLMSynthesizer,
  LLM_MIN_CONFIDENCE,
  getEffectiveFieldOptions,
  type BatchQuestion,
  type JobContext,
} from './llmSynthesizer.js';
import { upsertAnswer } from '../db/qaBank.js';
import { generateFingerprint } from './fingerprint.js';
import { writeEmbedding } from './semanticSearch.js';
import { profileRowToCandidateProfile, getCompanyEmail, type ProfileRow } from '../db/profiles.js';
import type { ResolvedField, ScannedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Tier5LLM');

export type LlmFailureReason = 'timeout' | 'rate_limit' | 'server_error' | 'permanent';

export interface LlmFailureInfo {
  reason: LlmFailureReason;
  isRetriable: boolean;
  message: string;
  statusCode?: number;
  timestamp: number;
}

let lastLlmFailure: LlmFailureInfo | null = null;

export function getLastLlmFailure(): LlmFailureInfo | null {
  return lastLlmFailure;
}

export function clearLastLlmFailure(): void {
  lastLlmFailure = null;
}

export function classifyLlmError(err: unknown): LlmFailureInfo {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    typeof err === 'object' && err !== null
      ? (err as { status?: number; statusCode?: number }).status ??
        (err as { statusCode?: number }).statusCode
      : undefined;

  let reason: LlmFailureReason = 'permanent';
  let isRetriable = false;

  if (status === 429 || /429|rate\s*limit|quota|too\s*many\s*requests/i.test(message)) {
    reason = 'rate_limit';
    isRetriable = true;
  } else if (
    (typeof status === 'number' && status >= 500 && status < 600) ||
    /5\d\d|bad\s*gateway|gateway\s*timeout|service\s*unavailable|internal\s*server\s*error/i.test(message)
  ) {
    reason = 'server_error';
    isRetriable = true;
  } else if (
    /timeout|timed\s*out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ESOCKETTIMEDOUT|AbortError/i.test(message) ||
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
  return profileRowToCandidateProfile(profile);
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
      };
    }
    return null;
  }

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
        log.warn(
          `[Tier 5] Confidence ${confidence} < ${LLM_MIN_CONFIDENCE} for ${applywizzId} [${field.label}] — leaving unresolved (no qa_bank write)`
        );
        return null;
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
      } catch (writeErr: unknown) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        log.warn(
          `[Tier 5] ⚠️ QA bank writeback failed for ${applywizzId} [fp: ${fingerprint}]: ${msg}`
        );
      }

      return resolvedField;
    }
  } catch (err: unknown) {
    const failure = classifyLlmError(err);
    lastLlmFailure = failure;
    if (failure.isRetriable) {
      log.warn(
        `[Tier 5] Retriable LLM synthesis failure (${failure.reason}) for ${applywizzId} [${field.label}]: ${failure.message}`
      );
    } else {
      log.error(
        `[Tier 5] Permanent LLM synthesis error for ${applywizzId} [${field.label}]: ${failure.message}`
      );
    }
  }

  return null;
}

/** Max LLM fields per batch API call within one candidate×job resolution. */
export const TIER5_BATCH_CHUNK_SIZE = 15;

/**
 * Tier 5 batch path: one LLM request per chunk, with the same post-validation as single-field synthesis.
 */
export async function resolveTier5Batch(
  applywizzId: string,
  fields: ScannedField[],
  candidateProfile: ProfileRow,
  jobContext: { companyName: string; jobTitle: string },
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
        };
      }
      continue;
    }
    llmFields.push(field);
    llmIndices.push(i);
  }

  if (llmFields.length === 0) return results;

  try {
    const batchQuestions: BatchQuestion[] = llmFields.map((field) => {
      const effectiveOptions = getEffectiveFieldOptions(field);
      return {
        label: field.label,
        type: field.type,
        options: effectiveOptions,
      };
    });

    const rawAnswers = await synthesizer.synthesizeBatchAnswers(
      batchQuestions,
      resumeText,
      jd,
      adaptedProfile
    );

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

      const resolvedField: ResolvedField = {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalized.value.trim(),
        source: 'ai',
        resolvedByTier: 5,
        confidence,
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
      } catch (writeErr: unknown) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        log.warn(
          `[Tier 5 Batch] ⚠️ QA bank writeback failed for ${applywizzId} [fp: ${fingerprint}]: ${msg}`
        );
      }

      results[llmIndices[j]] = resolvedField;
    }
  } catch (err: unknown) {
    const failure = classifyLlmError(err);
    lastLlmFailure = failure;
    if (failure.isRetriable) {
      log.warn(
        `[Tier 5 Batch] Retriable LLM batch failure (${failure.reason}) for ${applywizzId}: ${failure.message}`
      );
    } else {
      log.error(
        `[Tier 5 Batch] Permanent LLM batch error for ${applywizzId}: ${failure.message}`
      );
    }
  }

  return results;
}

export default resolveTier5;
