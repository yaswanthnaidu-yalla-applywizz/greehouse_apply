/**
 * @fileoverview 5-Tier Answer Resolution Engine Orchestrator (Greenhouse V2).
 *
 * Coordinates resolution in strict waterfall sequence (100% offline during resolution):
 * - Tier 1: Supabase profiles + exact candidate_qa_bank match (source: 'supabase', tier: 1)
 * - Tier 2: Parsed resume cache / Supabase Storage PDF parse (source: 'resume_parse', tier: 2)
 * - Tier 3: Semantic search over candidate profile facts, then candidate QA bank
 * - Tier 4: Fuzzy search over candidate profile facts, then candidate QA bank
 * - Tier 5: LLM synthesis + automatic QA bank writeback (source: 'ai', tier: 5)
 * - Fallback: Unresolved field (source: 'unresolved', tier: null)
 *
 * No ApplyWizz API calls are made during resolution. New candidates are onboarded at ingestion time only.
 */

import fs from 'fs';
import path from 'path';
import config from '../config/env.js';
import { getProfile, type ProfileRow } from '../db/profiles.js';
import { findAnswersByCandidate, type QABankRow } from '../db/qaBank.js';
import { getOrParseResume, type ResumeParsedRow } from './tier2ResumeParse.js';
import { isCountryField, resolveFromPayloadStructured, resolveTier1 } from './tier1Supabase.js';
import { resolveTier2 } from './tier2ResumeParse.js';
import { findSemanticMatch, getLastSemanticScore } from './semanticSearch.js';
import { resolveTier3 } from './tier3FuzzyMatch.js';
import { resolveTier5, resolveTier5Batch, TIER5_BATCH_CHUNK_SIZE } from './tier5LLM.js';
import { getEffectiveFieldOptions } from './llmSynthesizer.js';
import { normalizeText } from './fingerprint.js';
import { isPhoneNumberField, resumeAnswerMatchesPhone } from './candidateEvidence.js';
import {
  enqueueApplication,
  getApplicationByCandidateAndJob,
  RESOLVE_AUTO_ENQUEUE_ELIGIBLE,
  upsertApplication,
} from '../db/applications.js';
import { isWithinSubmissionQuestionLimit } from '../submission/questionLimit.js';
import { resolveShortlink, resolveShortlinksBatch } from '../scanner/csvDeduplicator.js';
import type {
  ApplicationStatus,
  CandidateJobApplication,
  CandidateSegment,
  ResolvedField,
  ScannedField,
  ScannedJobTemplate,
} from '../types/index.js';
import { createLogger, haltWithDevAlert, isMissingTableError, isSupabaseConnectionError } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import { throwIfPipelineAborted } from '../orchestrator/pipelineAbort.js';
import { hasAnyNonEmptyResolvedField } from '../utils/resolvedFields.js';
import { matchChoiceOption } from '../utils/choiceOptions.js';
import { applicationNeedsOperatorReview } from './needsReview.js';

export { applicationNeedsOperatorReview } from './needsReview.js';

function parseScoreFromJob(score: string | number | undefined): number | null {
  if (score === undefined || score === '') return null;
  const parsed = typeof score === 'number' ? score : parseFloat(score.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const log = createLogger('Answer Resolver');

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT',
  'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming',
]);

function profileIndicatesUsLocation(profile: ProfileRow | null): boolean {
  const additional = profile?.raw_api_payload?.additional_information;
  if (!additional || typeof additional !== 'object') return false;
  const values = [additional.zip_or_country, additional.state_of_residence]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return values.some((value) =>
    /\bunited states(?: of america)?\b|\busa\b|\bu\.s\.a?\b/i.test(value) ||
    value.split(/[\s,/-]+/).some((part) => US_STATE_CODES.has(part.toUpperCase())) ||
    value.toLowerCase().split(/[,/]+/).some((part) => US_STATE_NAMES.has(part.trim()))
  );
}

function getFieldOptions(field: ScannedField): string[] | undefined {
  return getEffectiveFieldOptions(field);
}

export function isUnsupportedUuidAnswer(field: ScannedField, answer: string): boolean {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(answer.trim())) {
    return false;
  }
  if (field.options?.some((option) => normalizeText(option) === normalizeText(answer))) return false;
  return !/\b(?:uuid|unique id|unique identifier|candidate id|application id|employee id|reference id|tracking id|id number)\b/i.test(
    `${field.label} ${field.name} ${field.fieldId}`
  );
}

function alignResolvedChoice(
  field: ScannedField,
  resolved: ResolvedField,
  effectiveOptions?: string[]
): ResolvedField {
  const options = effectiveOptions || getFieldOptions(field) || resolved.options;
  const baseWithOptions = {
    ...resolved,
    ...(options ? { options } : {}),
    ...(field.optionsComplete === undefined ? {} : { optionsComplete: field.optionsComplete }),
    ...(field.metadata ? { metadata: field.metadata } : {}),
  };
  if (resolved.source === 'unresolved' || !resolved.value.trim()) return baseWithOptions;
  if (isUnsupportedUuidAnswer(field, resolved.value)) {
    log.warn(`[Resolver] Rejected UUID-shaped answer for non-identifier field "${field.label}"`);
    return {
      ...baseWithOptions,
      value: '',
      source: 'unresolved',
      resolvedByTier: null,
      confidence: 0,
    };
  }
  if (field.type === 'checkbox') return baseWithOptions;
  if (field.type !== 'select' && field.type !== 'radio') return baseWithOptions;
  if (field.optionsComplete === false) {
    return { ...baseWithOptions, ...(field.options ? { options: field.options } : {}) };
  }

  const matched = matchChoiceOption(resolved.value, options);
  if (matched) return { ...baseWithOptions, value: matched };

  return {
    ...baseWithOptions,
    value: '',
    source: 'unresolved',
    resolvedByTier: null,
    confidence: 0,
  };
}

function alignResolvedChoiceOrNull(field: ScannedField, value: string): string | null {
  if (field.type === 'checkbox') return value;
  if (field.type !== 'select' && field.type !== 'radio') return value;
  if (field.optionsComplete === false) return value;
  return matchChoiceOption(value, field.options);
}

export function resolvePreTierField(
  field: ScannedField,
  profile: ProfileRow | null,
  isRequired: boolean,
  now = new Date()
): ResolvedField | null {
  const availability = resolveAvailabilityField(field, isRequired, now);
  if (availability) return availability;

  if (/^(do you|have you|are you)\b/i.test(field.label.trim())) return null;

  const options = getFieldOptions(field);
  const base = {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    source: 'supabase' as const,
    resolvedByTier: 1 as const,
    confidence: 1.0,
    isRequired,
    ...(options ? { options } : {}),
    ...(field.optionsComplete === undefined ? {} : { optionsComplete: field.optionsComplete }),
    ...(field.metadata ? { metadata: field.metadata } : {}),
  };

  if (/work\.auth|authorized\.to\.work|eligible\.to\.work/i.test(field.label)) {
    const targetVal = field.type === 'checkbox' ? 'true' : 'Yes';
    const finalVal = alignResolvedChoiceOrNull(field, targetVal);
    if (!finalVal) return null;
    log.info(`[Resolver] ✅ T1 ${field.label} → "${finalVal}"`);
    return { ...base, value: finalVal };
  }

  if (/currently (located|based|living|residing) in (the )?us|are you (in|based in) (the )?us|us.?based|located in (the )?united states|do you (live|reside) in (the )?us|currently located in the us/i.test(field.label) &&
    profileIndicatesUsLocation(profile)) {
    const finalVal = alignResolvedChoiceOrNull(field, 'Yes');
    if (!finalVal) return null;
    log.info(`[Resolver] ✅ PRE-TIER us-location "${field.label}" → "${finalVal}"`);
    return { ...base, value: finalVal };
  }

  if (/\b(?:I agree|I consent|I certify|I acknowledge|by checking|by selecting|by submitting)\b/i.test(field.label)) {
    const targetVal = field.type === 'checkbox' ? 'true' : 'Yes';
    const finalVal = alignResolvedChoiceOrNull(field, targetVal);
    if (!finalVal) return null;
    log.info(`[Resolver] ✅ PRE-TIER consent field "${field.label}" → "${finalVal}"`);
    return { ...base, value: finalVal };
  }

  return null;
}

function isAvailabilityDateField(field: ScannedField): boolean {
  const combined = `${field.label} ${field.name} ${field.fieldId}`;
  if (/\b(?:month|year|graduation|education|school|university|employment history)\b/i.test(combined)) {
    return false;
  }
  return /\b(?:date available to start|available to start|availability date|available date|desired start date|earliest start date|when can you start|when could you start)\b/i.test(
    combined
  ) || /^start date$/i.test(field.label.trim());
}

function formatAvailabilityDate(date: Date, format: string): string {
  const values: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    YY: String(date.getUTCFullYear()).slice(-2),
    MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
    M: String(date.getUTCMonth() + 1),
    DD: String(date.getUTCDate()).padStart(2, '0'),
    D: String(date.getUTCDate()),
  };
  return format.replace(/YYYY|YY|MM|M|DD|D/g, (token) => values[token] || token);
}

export function resolveAvailabilityField(
  field: ScannedField,
  isRequired: boolean,
  now = new Date()
): ResolvedField | null {
  if (!isAvailabilityDateField(field)) return null;

  const options = getFieldOptions(field);
  let value: string | null = null;
  if (field.type === 'select' || field.type === 'radio') {
    if (!field.options?.length) return null;
    const weekOptions = field.options.filter((option) =>
      /\b(?:1|one)\s*(?:week|wk)\b|\bwithin\s+(?:a|one)\s+week\b/i.test(option)
    );
    if (weekOptions.length === 1) {
      value = weekOptions[0];
    } else {
      const immediateOptions = field.options
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => /^immediately\b/i.test(option.trim()));
      if (immediateOptions.length === 1) {
        value = field.options[immediateOptions[0].index + 1] || null;
      }
    }
  } else if (field.type === 'text' || field.type === 'date' || field.metadata?.inputType === 'date') {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7));
    const format =
      field.metadata?.expectedDateFormat ||
      (field.type === 'date' || field.metadata?.inputType === 'date' ? 'YYYY-MM-DD' : 'MM/DD/YYYY');
    value = formatAvailabilityDate(date, format);
  }

  if (!value) return null;
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value,
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1,
    isRequired,
    ...(options ? { options } : {}),
    ...(field.optionsComplete === undefined ? {} : { optionsComplete: field.optionsComplete }),
    ...(field.metadata ? { metadata: field.metadata } : {}),
  };
}

function resolveStructuredEeocField(
  field: ScannedField,
  profile: ProfileRow | null,
  isRequired: boolean
): ResolvedField | null {
  const normalizedLabel = normalizeText(field.label);
  if (!/^gender$|^race$|^race and ethnicity$|^ethnicity$|^veteran|^disability/.test(normalizedLabel)) {
    return null;
  }

  const value = profile?.raw_api_payload
    ? resolveFromPayloadStructured(normalizedLabel, field.type, profile.raw_api_payload)
    : null;
  if (!value) return null;

  log.info(`[Resolver] ✅ T1-STRUCT ${field.label} → "${value}"`);
  const options = getFieldOptions(field);
  return {
    fieldId: field.fieldId,
    name: field.name,
    type: field.type,
    label: field.label,
    value,
    source: 'supabase',
    resolvedByTier: 1,
    confidence: 1.0,
    isRequired,
    ...(options ? { options } : {}),
    ...(field.optionsComplete === undefined ? {} : { optionsComplete: field.optionsComplete }),
  };
}

/**
 * Returns a human-readable resolution source label for logging.
 */
export function formatResolutionSource(resolved: ResolvedField): string {
  if (resolved.source === 'unresolved' || resolved.resolvedByTier === null) {
    return '⚪ Unresolved';
  }
  if (resolved.source === 'resume_parse' || resolved.resolvedByTier === 2) {
    return '🔵 Resume';
  }
  if (resolved.source === 'semantic' || resolved.resolvedByTier === 3) {
    return '🧠 Semantic';
  }
  if (resolved.source === 'fuzzy_match' || resolved.resolvedByTier === 4) {
    return '🟡 Fuzzy';
  }
  if (resolved.source === 'ai' || resolved.resolvedByTier === 5) {
    return '🤖 LLM';
  }
  if (resolved.source === 'supabase' || resolved.resolvedByTier === 1) {
    return '🟢 Supabase';
  }
  return `⚪ ${resolved.source}`;
}

/**
 * Returns a short resolution source key for batch summary logs.
 */
export function isResolvedApplicationSuccessful(app: CandidateJobApplication): boolean {
  if (app.status === 'EXPIRED') return false;
  if (app.status !== 'READY_FOR_REVIEW') return false;
  return !app.resolvedFields.some((f) => f.source === 'unresolved' || f.resolvedByTier === null);
}

export function resolutionSourceKey(resolved: ResolvedField): 'supabase' | 'resume' | 'semantic' | 'fuzzy' | 'llm' | 'unresolved' | 'other' {
  if (resolved.source === 'unresolved' || resolved.resolvedByTier === null) return 'unresolved';
  if (resolved.source === 'resume_parse' || resolved.resolvedByTier === 2) return 'resume';
  if (resolved.source === 'semantic' || resolved.resolvedByTier === 3) return 'semantic';
  if (resolved.source === 'fuzzy_match' || resolved.resolvedByTier === 4) return 'fuzzy';
  if (resolved.source === 'ai' || resolved.resolvedByTier === 5) return 'llm';
  if (resolved.source === 'supabase' || resolved.resolvedByTier === 1) return 'supabase';
  return 'other';
}

export interface ResolutionTelemetry {
  totalFields: number;
  tier1Hits: number;
  tier2Hits: number;
  tier3Hits: number;
  tier4Hits: number;
  tier5Hits: number;
  unresolvedCount: number;
}

function getTier5FailureReason(): string {
  return 'no supported answer';
}

/**
 * Orchestrator running the 3-tier Supabase-only waterfall resolution engine.
 */
export class AnswerResolver {
  /**
   * Resolves a single scanned form field through the 3-tier waterfall.
   */
  public async resolveField(
    applywizzId: string,
    field: ScannedField,
    context?: {
      profile?: ProfileRow | null;
      parsedResume?: ResumeParsedRow | null;
      qaEntries?: QABankRow[];
      jobContext?: { companyName: string; jobTitle: string };
    }
  ): Promise<ResolvedField> {
    const resolved = await this.resolveFieldRaw(applywizzId, field, context);
    return alignResolvedChoice(field, resolved, getEffectiveFieldOptions(field));
  }

  private async resolveFieldRaw(
    applywizzId: string,
    field: ScannedField,
    context?: {
      profile?: ProfileRow | null;
      parsedResume?: ResumeParsedRow | null;
      qaEntries?: QABankRow[];
      jobContext?: { companyName: string; jobTitle: string };
    }
  ): Promise<ResolvedField> {
    const profile = context?.profile || (await getProfile(applywizzId));
    const jobContext = context?.jobContext || { companyName: 'Company', jobTitle: 'Position' };
    const isRequired = Boolean(field.isRequired || (field as any).required || (field as any).is_required);
    const resolutionField = field.optionsComplete === false ? { ...field, options: undefined } : field;

    const preTier = resolvePreTierField(field, profile, isRequired);
    if (preTier) return preTier;

    // Never fill cover letters under any circumstances
    if (/cover\s*letter|cover_letter/i.test(`${field.name} ${field.fieldId} ${field.label}`)) {
      log.info(`[Resolver] ✅ T1 ${field.label} → ""`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: '',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired,
      };
    }

    const structuredEeoc = resolveStructuredEeocField(resolutionField, profile, isRequired);
    if (structuredEeoc) return structuredEeoc;

    // ------------------------------------------------------------------------
    // Tier 1: Supabase Profile & Exact QA Bank
    // ------------------------------------------------------------------------
    const tier1 = await resolveTier1(applywizzId, resolutionField, profile);
    if (tier1) {
      return { ...tier1, isRequired };
    }
    log.info(`[Resolver] ❌ T1 ${field.label} — no profile match`);

    // Optional fields normally stop after Tier 1; standalone country fields can still use payload evidence.
    if (!isRequired && !isCountryField(field)) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: '',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired,
      };
    }

    // ------------------------------------------------------------------------
    // Tier 2: Resume Parse Cache / Extractor
    // ------------------------------------------------------------------------
    const parsedResume =
      context?.parsedResume !== undefined
        ? context.parsedResume
        : await getOrParseResume(applywizzId);

    const tier2 = await resolveTier2(applywizzId, resolutionField, parsedResume);
    if (tier2) {
      log.info(`[Resolver] ✅ T2 ${field.label} → "${tier2.value}"`);
      return { ...tier2, isRequired };
    }
    log.info(`[Resolver] ❌ T2 ${field.label} — no resume match`);

    // ------------------------------------------------------------------------
    // Tier 3: Semantic Search (vector embedding match against candidate_qa_bank)
    // ------------------------------------------------------------------------
    const semanticMatch = await findSemanticMatch(
      field.label,
      applywizzId,
      resolutionField.type,
      resolutionField.options,
      0.82,
      profile
    );
    if (semanticMatch) {
      const phone = isPhoneNumberField(field)
        ? resumeAnswerMatchesPhone(semanticMatch.value, parsedResume?.structured, parsedResume?.raw_text)
        : semanticMatch.value;
      if (phone) {
        log.info(`[Resolver] ✅ T3 ${field.label} → resume phone`);
        return {
          fieldId: field.fieldId,
          name: field.name,
          type: field.type,
          label: field.label,
          value: phone,
          source: 'semantic',
          resolvedByTier: 3,
          confidence: semanticMatch.confidence,
          isRequired,
        };
      }
      if (isPhoneNumberField(field)) {
        log.info(`[Resolver] ❌ T3 ${field.label} — answer not verified against resume`);
      } else {
      log.info(`[Resolver] ✅ T3 ${field.label} → "${semanticMatch.value}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: semanticMatch.value,
        source: 'semantic',
        resolvedByTier: 3,
        confidence: semanticMatch.confidence,
        isRequired,
      };
      }
    }
    const t3Score = getLastSemanticScore().toFixed(2);
    log.info(`[Resolver] ❌ T3 ${field.label} — below similarity threshold (${t3Score})`);

    // ------------------------------------------------------------------------
    // Tier 4: Fuse.js Fuzzy Match against candidate_qa_bank
    // ------------------------------------------------------------------------
    const tier4 = await resolveTier3(
      applywizzId,
      resolutionField,
      context?.qaEntries,
      profile
    );
    if (tier4) {
      const phone = isPhoneNumberField(field)
        ? resumeAnswerMatchesPhone(tier4.value, parsedResume?.structured, parsedResume?.raw_text)
        : tier4.value;
      if (phone) {
        log.info(`[Resolver] ✅ T4 ${field.label} → resume phone`);
        return {
          ...tier4,
          value: phone,
          resolvedByTier: 4,
          isRequired,
        };
      }
      if (isPhoneNumberField(field)) {
        log.info(`[Resolver] ❌ T4 ${field.label} — answer not verified against resume`);
      } else {
      log.info(`[Resolver] ✅ T4 ${field.label} → "${tier4.value}"`);
      return {
        ...tier4,
        resolvedByTier: 4,
        isRequired,
      };
      }
    }
    log.info(`[Resolver] ❌ T4 ${field.label} — no fuzzy match`);

    // ------------------------------------------------------------------------
    // Tier 5: Multi-provider LLM Synthesis
    // ------------------------------------------------------------------------
    if (profile) {
      const tier5 = await resolveTier5(
        applywizzId,
        field,
        profile,
        jobContext,
        parsedResume?.raw_text || ''
      );
      if (tier5 && tier5.value && tier5.value.trim().length > 0) {
        log.info(`[Resolver] ✅ T5 ${field.label} → "${tier5.value}"`);
        return { ...tier5, isRequired };
      }
    }

    const t5Reason = getTier5FailureReason();
    log.info(`[Resolver] ❌ T5 ${field.label} — ${t5Reason}`);

    return this.unresolvedField(field);
  }

  private unresolvedField(field: ScannedField): ResolvedField {
    const options = getFieldOptions(field);
    return {
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      value: '',
      source: 'unresolved',
      resolvedByTier: null,
      confidence: 0,
      isRequired: Boolean(field.isRequired),
      ...(options ? { options } : {}),
      ...(field.optionsComplete === undefined ? {} : { optionsComplete: field.optionsComplete }),
      ...(field.metadata ? { metadata: field.metadata } : {}),
    };
  }

  /**
   * Pre-LLM waterfall (Tiers 1–4) used before batched Tier 5 within resolveJobApplication.
   */
  private async resolveFieldThroughTier2(
    applywizzId: string,
    field: ScannedField,
    context: {
      profile?: ProfileRow | null;
      parsedResume?: ResumeParsedRow | null;
      qaEntries?: QABankRow[];
      jobContext?: { companyName: string; jobTitle: string };
    }
  ): Promise<ResolvedField> {
    const resolved = await this.resolveFieldThroughTier2Raw(applywizzId, field, context);
    return alignResolvedChoice(field, resolved, getEffectiveFieldOptions(field));
  }

  private async resolveFieldThroughTier2Raw(
    applywizzId: string,
    field: ScannedField,
    context: {
      profile?: ProfileRow | null;
      parsedResume?: ResumeParsedRow | null;
      qaEntries?: QABankRow[];
      jobContext?: { companyName: string; jobTitle: string };
    }
  ): Promise<ResolvedField> {
    const profile = context.profile || (await getProfile(applywizzId));
    const isRequired = Boolean(field.isRequired || (field as any).required || (field as any).is_required);
    const resolutionField = field.optionsComplete === false ? { ...field, options: undefined } : field;

    const preTier = resolvePreTierField(field, profile, isRequired);
    if (preTier) return preTier;

    if (/cover\s*letter|cover_letter/i.test(`${field.name} ${field.fieldId} ${field.label}`)) {
      log.info(`[Resolver] ✅ T1 ${field.label} → ""`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: '',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired,
      };
    }

    const structuredEeoc = resolveStructuredEeocField(resolutionField, profile, isRequired);
    if (structuredEeoc) return structuredEeoc;

    const tier1 = await resolveTier1(applywizzId, resolutionField, profile);
    if (tier1) {
      return { ...tier1, isRequired };
    }
    log.info(`[Resolver] ❌ T1 ${field.label} — no profile match`);

    if (!isRequired && !isCountryField(field)) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: '',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
        isRequired,
      };
    }

    const parsedResume =
      context.parsedResume !== undefined
        ? context.parsedResume
        : await getOrParseResume(applywizzId);

    const tier2 = await resolveTier2(applywizzId, resolutionField, parsedResume);
    if (tier2) {
      log.info(`[Resolver] ✅ T2 ${field.label} → "${tier2.value}"`);
      return { ...tier2, isRequired };
    }
    log.info(`[Resolver] ❌ T2 ${field.label} — no resume match`);

    // ------------------------------------------------------------------------
    // Tier 3: Semantic Search (vector embedding match against candidate_qa_bank)
    // ------------------------------------------------------------------------
    const semanticMatch = await findSemanticMatch(
      field.label,
      applywizzId,
      resolutionField.type,
      resolutionField.options,
      0.82,
      profile
    );
    if (semanticMatch) {
      log.info(`[Resolver] ✅ T3 ${field.label} → "${semanticMatch.value}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: semanticMatch.value,
        source: 'semantic',
        resolvedByTier: 3,
        confidence: semanticMatch.confidence,
        isRequired,
      };
    }
    const t3Score = getLastSemanticScore().toFixed(2);
    log.info(`[Resolver] ❌ T3 ${field.label} — below similarity threshold (${t3Score})`);

    // ------------------------------------------------------------------------
    // Tier 4: Fuse.js Fuzzy Match against candidate_qa_bank
    // ------------------------------------------------------------------------
    const tier4 = await resolveTier3(
      applywizzId,
      resolutionField,
      context.qaEntries,
      profile
    );
    if (tier4) {
      log.info(`[Resolver] ✅ T4 ${field.label} → "${tier4.value}"`);
      return {
        ...tier4,
        resolvedByTier: 4,
        isRequired,
      };
    }
    log.info(`[Resolver] ❌ T4 ${field.label} — no fuzzy match`);

    return this.unresolvedField(field);
  }

  /**
   * Resolves all form fields for a candidate-job pairing.
   */
  public async resolveJobApplication(
    applywizzId: string,
    template: ScannedJobTemplate
  ): Promise<CandidateJobApplication> {
    const profile = await getProfile(applywizzId);
    const parsedResume = await getOrParseResume(applywizzId);
    const qaEntries = await findAnswersByCandidate(applywizzId);

    const candidateName = profile?.client_name || applywizzId;
    const jobContext = {
      companyName: template.companyName || 'Company',
      jobTitle: template.jobTitle || 'Position',
    };

    if (template.isExpired || !template.fields || template.fields.length === 0) {
      return {
        applywizzId,
        candidateName,
        jobUrl: template.jobUrl,
        companyName: template.companyName || '',
        jobTitle: template.jobTitle || '',
        status: 'EXPIRED',
        resolvedFields: [],
        assignedCaEmail: profile?.ca_email || null,
      };
    }

    const resolvedFields: ResolvedField[] = [];
    const verbose = !isPipelineCompactLogging();
    if (verbose) {
      log.info(
        `\n[Answer Resolver] 👤 Resolving [${candidateName}] for "${template.jobTitle}" at "${template.companyName}" (${template.fields.length} questions)...`
      );
    }

    const tier5Pending: ScannedField[] = [];
    const tier5Slots: number[] = [];

    for (const field of template.fields) {
      const resolved = await this.resolveFieldThroughTier2(applywizzId, field, {
        profile,
        parsedResume,
        qaEntries,
        jobContext,
      });
      resolvedFields.push(resolved);

      if (resolved.source === 'unresolved') {
        if (profile) {
          tier5Slots.push(resolvedFields.length - 1);
          tier5Pending.push(field);
        } else {
          log.info(`[Resolver] ❌ T5 ${field.label} — unresolved`);
        }
      }
    }

    const resumeText = parsedResume?.raw_text || '';
    const jobDescription = '';

    for (let offset = 0; offset < tier5Pending.length; offset += TIER5_BATCH_CHUNK_SIZE) {
      throwIfPipelineAborted('Answer resolution');
      const chunkFields = tier5Pending.slice(offset, offset + TIER5_BATCH_CHUNK_SIZE);
      const chunkSlots = tier5Slots.slice(offset, offset + TIER5_BATCH_CHUNK_SIZE);
      if (!profile || chunkFields.length === 0) continue;

      const batchResults = await resolveTier5Batch(
        applywizzId,
        chunkFields,
        profile,
        jobContext,
        resumeText,
        jobDescription
      );

      for (let i = 0; i < chunkFields.length; i++) {
        const tier5 = batchResults[i];
        if (tier5 && tier5.value && tier5.value.trim().length > 0) {
          const alignedTier5 = alignResolvedChoice(
            chunkFields[i],
            tier5,
            tier5.options || getEffectiveFieldOptions(chunkFields[i])
          );
          resolvedFields[chunkSlots[i]] = alignedTier5;
          if (alignedTier5.source === 'unresolved') {
            log.info(`[Resolver] ❌ T5 ${chunkFields[i].label} — no option match`);
          } else {
            log.info(`[Resolver] ✅ T5 ${chunkFields[i].label} → "${alignedTier5.value}"`);
          }
        } else {
          const reason = getTier5FailureReason();
          log.info(`[Resolver] ❌ T5 ${chunkFields[i].label} — ${reason}`);
        }
      }
    }

    // Ensure every resolved field retains choice metadata from the scanned template
    for (let i = 0; i < template.fields.length; i++) {
      const field = template.fields[i];
      const resolved = resolvedFields[i];
      if (resolved) {
        if (field.metadata) resolved.metadata = { ...field.metadata, ...resolved.metadata };
        if (field.options) resolved.options = field.options;
        if (field.optionsComplete !== undefined) {
          resolved.optionsComplete = field.optionsComplete;
        }
      }
    }

    return {
      applywizzId,
      candidateName,
      jobUrl: template.jobUrl,
      companyName: template.companyName || '',
      jobTitle: template.jobTitle || '',
      status: 'READY_FOR_REVIEW' as ApplicationStatus,
      resolvedFields,
      assignedCaEmail: profile?.ca_email || null,
    };
  }

  /**
   * Batch resolves candidate segments against scanned job templates.
   */
  public async resolveAllApplications(
    segments: CandidateSegment[],
    templates: ScannedJobTemplate[]
  ): Promise<CandidateJobApplication[]> {
    const templateMap = new Map<string, ScannedJobTemplate>();
    for (const t of templates) {
      templateMap.set(t.jobUrl, t);
    }

    const applications: CandidateJobApplication[] = [];
    let totalPairs = 0;

    for (const seg of segments) {
      totalPairs += seg.jobs.length;
    }

    const compact = isPipelineCompactLogging();
    if (!compact) {
      log.info(
        `[Answer Resolver] 🚀 Resolving answers across ${segments.length} candidates and ${totalPairs} job assignments (Supabase → Resume → LLM)...`
      );
    } else {
      log.info(
        `[Answer Resolver] resolve start candidates=${segments.length} job_assignments=${totalPairs}`
      );
    }

    // Pre-resolve shortlinks if any
    const shortlinksToResolve = new Set<string>();
    for (const seg of segments) {
      for (const job of seg.jobs) {
        if (job.rawUrl && job.rawUrl.includes('grnh.se')) shortlinksToResolve.add(job.rawUrl);
        if (job.canonicalUrl && job.canonicalUrl.includes('grnh.se')) shortlinksToResolve.add(job.canonicalUrl);
      }
    }

    if (shortlinksToResolve.size > 0) {
      await resolveShortlinksBatch(Array.from(shortlinksToResolve), 50);
    }

    type ResolveJobTask = { seg: CandidateSegment; job: CandidateSegment['jobs'][number] };
    const tasks: ResolveJobTask[] = [];
    for (const seg of segments) {
      for (const job of seg.jobs) {
        tasks.push({ seg, job });
      }
    }

    const poolSize = Math.max(1, Math.min(5, config.RESOLVER_WORKER_POOL_SIZE));
    if (compact) {
      log.info(`[Answer Resolver] resolve workers=${poolSize}`);
    }

    const segStats = new Map<
      string,
      { successful: number; unsuccessful: number; noTemplate: number; failed: number; total: number }
    >();
    for (const seg of segments) {
      segStats.set(seg.applywizzId, {
        successful: 0,
        unsuccessful: 0,
        noTemplate: 0,
        failed: 0,
        total: seg.jobs.length,
      });
    }

    let nextTaskIndex = 0;
    let resolvedCount = 0;
    let totalSuccessful = 0;
    let totalUnsuccessful = 0;
    const noTemplateLoggedUrls = new Set<string>();

    const processResolveTask = async (): Promise<void> => {
      while (true) {
        throwIfPipelineAborted('Answer resolution');
        const taskIndex = nextTaskIndex++;
        if (taskIndex >= tasks.length) break;

        const { seg, job } = tasks[taskIndex];
        const stats = segStats.get(seg.applywizzId)!;

        let canonical = job.canonicalUrl || job.rawUrl;
        if (canonical.includes('grnh.se')) {
          canonical = await resolveShortlink(canonical);
        }

        const template =
          templateMap.get(canonical) ||
          templateMap.get(job.canonicalUrl) ||
          templateMap.get(job.rawUrl) ||
          Array.from(templateMap.values()).find(
            (t) => t.jobUrl.includes(canonical) || canonical.includes(t.jobUrl)
          );

        const persistJobUrl = job.canonicalUrl || job.rawUrl || template?.jobUrl || '';

        if (!template) {
          stats.noTemplate++;
          if (!noTemplateLoggedUrls.has(persistJobUrl)) {
            noTemplateLoggedUrls.add(persistJobUrl);
            log.info(
              `[Resolver] ⏭️ Skipping candidate_applications upsert for ${seg.applywizzId} ${persistJobUrl} — no scan template`
            );
          }
          continue;
        }

        const questionCount = template.fields?.length || 0;

        let app: CandidateJobApplication;
        try {
          app = await this.resolveJobApplication(seg.applywizzId, template);
        } catch (resolveErr: any) {
          if (isMissingTableError(resolveErr)) {
            haltWithDevAlert(
              'Migration',
              'required migration not applied (e.g. missing table error)',
              resolveErr
            );
          }
          if (isSupabaseConnectionError(resolveErr)) {
            haltWithDevAlert(
              'Supabase',
              'Supabase connection failure — bad credentials, unreachable, or empty key probe',
              resolveErr
            );
          }
          stats.failed++;
          if (!compact) {
            log.warn(
              `[Answer Resolver] ⚠️ Failed to resolve ${seg.applywizzId} ${persistJobUrl}: ${resolveErr.message}`
            );
          }
          continue;
        }

        if (isResolvedApplicationSuccessful(app)) {
          stats.successful++;
          totalSuccessful++;
        } else {
          stats.unsuccessful++;
          totalUnsuccessful++;
        }

        applications.push(app);
        resolvedCount++;

        if (app.status === 'EXPIRED' || template.isExpired) {
          log.info(
            `[Resolver] ⏭️ Skipping candidate_applications upsert for ${seg.applywizzId} ${persistJobUrl} — job expired or scan failed`
          );
        } else if (!hasAnyNonEmptyResolvedField(app.resolvedFields)) {
          log.info(
            `[Resolver] ⏭️ Skipping candidate_applications upsert for ${seg.applywizzId} ${persistJobUrl} — no fields resolved`
          );
        } else {
          try {
            const assignedCaEmail =
              app.assignedCaEmail || (seg as any).assignedCaEmail || seg.profile?.ca_email || null;
            const needsReview = applicationNeedsOperatorReview(app.resolvedFields);
            const existing = await getApplicationByCandidateAndJob(app.applywizzId, persistJobUrl);
            const existingStatus = existing?.status;
            const withinQuestionLimit = isWithinSubmissionQuestionLimit({
              field_count: questionCount,
            }).eligible;
            const canAutoEnqueue =
              !needsReview &&
              withinQuestionLimit &&
              (!existingStatus || RESOLVE_AUTO_ENQUEUE_ELIGIBLE.has(existingStatus));

            await upsertApplication({
              applywizz_id: app.applywizzId,
              job_url: persistJobUrl,
              company_name: app.companyName,
              job_title: app.jobTitle,
              resolved_fields: app.resolvedFields,
              csv_job_score: parseScoreFromJob(job.score),
              field_count: questionCount,
              assigned_ca_email: assignedCaEmail,
              status: 'READY_FOR_REVIEW',
            });

            if (canAutoEnqueue) {
              try {
                await enqueueApplication(app.applywizzId, {
                  jobUrl: persistJobUrl,
                  assignedCaEmail: assignedCaEmail || undefined,
                });
                log.info(
                  `[Answer Resolver] Auto-queued ${app.applywizzId} ${persistJobUrl} (no required AI/unresolved fields)`
                );
              } catch (enqueueErr: any) {
                log.warn(
                  `[Answer Resolver] ⚠️ Auto-enqueue skipped for ${app.applywizzId} ${persistJobUrl}: ${enqueueErr?.message || enqueueErr}`
                );
              }
            }
          } catch (dbErr: any) {
            if (isMissingTableError(dbErr)) {
              haltWithDevAlert(
                'Migration',
                'required migration not applied (e.g. missing table error)',
                dbErr
              );
            }
            if (isSupabaseConnectionError(dbErr)) {
              haltWithDevAlert(
                'Supabase',
                'Supabase connection failure — bad credentials, unreachable, or empty key probe',
                dbErr
              );
            }
            log.warn(`[Answer Resolver] ⚠️ Could not upsert candidate_applications: ${dbErr.message}`);
          }
        }

      }
    };

    await Promise.all(Array.from({ length: poolSize }, () => processResolveTask()));

    for (const seg of segments) {
      const stats = segStats.get(seg.applywizzId)!;
      const candidateApps = applications.filter((app) => app.applywizzId === seg.applywizzId);
      const tierCounts = [1, 2, 3, 4, 5].map((tier) =>
        candidateApps.reduce(
          (count, app) =>
            count + app.resolvedFields.filter((field) => field.resolvedByTier === tier).length,
          0
        )
      );
      const fields = candidateApps.reduce((count, app) => count + app.resolvedFields.length, 0);
      const resolved = candidateApps.reduce(
        (count, app) =>
          count +
          app.resolvedFields.filter(
            (field) => field.resolvedByTier !== null && field.source !== 'unresolved'
          ).length,
        0
      );
      log.info(
        `[Resolver] candidate=${seg.applywizzId} jobs=${stats.total} fields=${fields} resolved=${resolved} unresolved=${fields - resolved} t1=${tierCounts[0]} t2=${tierCounts[1]} t3=${tierCounts[2]} t4=${tierCounts[3]} t5=${tierCounts[4]}`
      );
    }

    if (compact) {
      log.info(
        `[Answer Resolver] resolve complete applications=${applications.length} successful=${totalSuccessful} unsuccessful=${totalUnsuccessful}`
      );
    }

    return applications;
  }
}

/**
 * Serializes resolved applications to disk.
 */
export async function exportResolvedApplications(
  applications: CandidateJobApplication[],
  outputDir: string = config.OUTPUT_DIR
): Promise<string> {
  const resolvedDir = path.resolve(process.cwd(), outputDir);

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const jsonPath = path.join(resolvedDir, 'resolved_applications.json');
  const serialized = JSON.stringify(applications, null, 2);

  await fs.promises.writeFile(jsonPath, serialized, 'utf-8');
  return jsonPath;
}

/**
 * Convenience helper to resolve an array of fields.
 */
export async function resolveFields(
  applywizzId: string,
  fields: ScannedField[],
  jobContext?: { companyName: string; jobTitle: string }
): Promise<{ resolvedFields: ResolvedField[]; telemetry: ResolutionTelemetry }> {
  const resolver = new AnswerResolver();
  const profile = await getProfile(applywizzId);
  const parsedResume = await getOrParseResume(applywizzId);
  const qaEntries = await findAnswersByCandidate(applywizzId);

  const resolvedFields: ResolvedField[] = [];
  const telemetry: ResolutionTelemetry = {
    totalFields: fields.length,
    tier1Hits: 0,
    tier2Hits: 0,
    tier3Hits: 0,
    tier4Hits: 0,
    tier5Hits: 0,
    unresolvedCount: 0,
  };

  for (const field of fields) {
    const res = await resolver.resolveField(applywizzId, field, {
      profile,
      parsedResume,
      qaEntries,
      jobContext,
    });
    resolvedFields.push(res);

    switch (res.resolvedByTier) {
      case 1:
        telemetry.tier1Hits++;
        break;
      case 2:
        telemetry.tier2Hits++;
        break;
      case 3:
        telemetry.tier3Hits++;
        break;
      case 4:
        telemetry.tier4Hits++;
        break;
      case 5:
        telemetry.tier5Hits++;
        break;
      default:
        telemetry.unresolvedCount++;
        break;
    }
  }

  return { resolvedFields, telemetry };
}

export default AnswerResolver;
