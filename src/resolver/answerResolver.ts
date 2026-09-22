/**
 * @fileoverview 3-Tier Answer Resolution Engine Orchestrator (Greenhouse V2).
 *
 * Coordinates resolution in strict waterfall sequence (100% offline during resolution):
 * - Tier 1: Supabase profiles + exact candidate_qa_bank match (source: 'supabase', tier: 1)
 * - Tier 2: Parsed resume cache / Supabase Storage PDF parse (source: 'resume_parse', tier: 2)
 * - Tier 5: Local Ollama LLM synthesis + automatic QA bank writeback (source: 'ai', tier: 5)
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
import { resolveTier1 } from './tier1Supabase.js';
import { resolveTier2 } from './tier2ResumeParse.js';
import { findSemanticMatch, getLastSemanticScore } from './semanticSearch.js';
import { resolveTier3 } from './tier3FuzzyMatch.js';
import { resolveTier5, resolveTier5Batch, TIER5_BATCH_CHUNK_SIZE, getLastLlmFailure } from './tier5LLM.js';
import { getEffectiveFieldOptions } from './llmSynthesizer.js';
import { upsertApplication } from '../db/applications.js';
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
import { parseCsvJobScore } from '../submission/submissionEligibilityGate.js';

function parseScoreFromJob(score: string | number | undefined): number | null {
  return parseCsvJobScore(score);
}

const log = createLogger('Answer Resolver');

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

function getTier5FailureReason(field: ScannedField): string {
  const options = getEffectiveFieldOptions(field);
  if (options && options.length > 0) {
    return 'no option match';
  }
  if (getLastLlmFailure()) {
    return 'LLM parse error';
  }
  return 'unresolved';
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
    const profile = context?.profile || (await getProfile(applywizzId));
    const jobContext = context?.jobContext || { companyName: 'Company', jobTitle: 'Position' };
    const isRequired = Boolean(field.isRequired || (field as any).required || (field as any).is_required);

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
      };
    }

    // Hardcoded rule: Work authorization questions always resolve to "Yes" with source 'supabase'
    if (/work\.auth|authorized\.to\.work|eligible\.to\.work/i.test(field.label)) {
      const targetVal = field.type === 'checkbox' ? 'true' : 'Yes';
      const finalVal = field.options && field.options.length > 0
        ? (field.options.find((o) => /^(yes|agree|i agree|accept|i accept|true|authorized)/i.test(o.trim())) || field.options[0])
        : targetVal;
      log.info(`[Resolver] ✅ T1 ${field.label} → "${finalVal}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
      };
    }

    // Hardcoded rule: Country questions always resolve to "United States" with source 'supabase'
    if (/country/i.test(field.label)) {
      const targetVal = 'United States';
      const finalVal = field.options && field.options.length > 0
        ? (field.options.find((o) => /united states|usa|u\.s\./i.test(o.trim())) || field.options[0])
        : targetVal;
      log.info(`[Resolver] ✅ T1 ${field.label} → "${finalVal}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
      };
    }

    // ------------------------------------------------------------------------
    // Tier 1: Supabase Profile & Exact QA Bank
    // ------------------------------------------------------------------------
    const tier1 = await resolveTier1(applywizzId, field, profile);
    if (tier1) {
      log.info(`[Resolver] ✅ T1 ${field.label} → "${tier1.value}"`);
      return tier1;
    }
    log.info(`[Resolver] ❌ T1 ${field.label} — no profile match`);

    // If the field is NOT mandatory and wasn't found in Supabase/Profile, do NOT spend time
    // running Tier 2 (resume parse) or Tier 5 (LLM). Leave it clean and empty.
    if (!isRequired) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: '',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
      };
    }

    // ------------------------------------------------------------------------
    // Tier 2: Resume Parse Cache / Extractor
    // ------------------------------------------------------------------------
    const parsedResume =
      context?.parsedResume !== undefined
        ? context.parsedResume
        : await getOrParseResume(applywizzId);

    const tier2 = await resolveTier2(applywizzId, field, parsedResume);
    if (tier2) {
      log.info(`[Resolver] ✅ T2 ${field.label} → "${tier2.value}"`);
      return tier2;
    }
    log.info(`[Resolver] ❌ T2 ${field.label} — no resume match`);

    // ------------------------------------------------------------------------
    // Tier 3: Semantic Search (vector embedding match against candidate_qa_bank)
    // ------------------------------------------------------------------------
    const semanticMatch = await findSemanticMatch(field.label, applywizzId, field.type);
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
      };
    }
    const t3Score = getLastSemanticScore().toFixed(2);
    log.info(`[Resolver] ❌ T3 ${field.label} — below similarity threshold (${t3Score})`);

    // ------------------------------------------------------------------------
    // Tier 4: Fuse.js Fuzzy Match against candidate_qa_bank
    // ------------------------------------------------------------------------
    const tier4 = await resolveTier3(applywizzId, field, context?.qaEntries);
    if (tier4) {
      log.info(`[Resolver] ✅ T4 ${field.label} → "${tier4.value}"`);
      return {
        ...tier4,
        resolvedByTier: 4,
      };
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
        return tier5;
      }
    }

    const t5Reason = getTier5FailureReason(field);
    log.info(`[Resolver] ❌ T5 ${field.label} — ${t5Reason}`);

    return this.unresolvedField(field);
  }

  private unresolvedField(field: ScannedField): ResolvedField {
    return {
      fieldId: field.fieldId,
      name: field.name,
      type: field.type,
      label: field.label,
      value: '',
      source: 'unresolved',
      resolvedByTier: null,
      confidence: 0,
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
    const profile = context.profile || (await getProfile(applywizzId));
    const isRequired = Boolean(field.isRequired || (field as any).required || (field as any).is_required);

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
      };
    }

    // Hardcoded rule: Work authorization questions always resolve to "Yes" with source 'supabase'
    if (/work\.auth|authorized\.to\.work|eligible\.to\.work/i.test(field.label)) {
      const targetVal = field.type === 'checkbox' ? 'true' : 'Yes';
      const finalVal = field.options && field.options.length > 0
        ? (field.options.find((o) => /^(yes|agree|i agree|accept|i accept|true|authorized)/i.test(o.trim())) || field.options[0])
        : targetVal;
      log.info(`[Resolver] ✅ T1 ${field.label} → "${finalVal}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
      };
    }

    // Hardcoded rule: Country questions always resolve to "United States" with source 'supabase'
    if (/country/i.test(field.label)) {
      const targetVal = 'United States';
      const finalVal = field.options && field.options.length > 0
        ? (field.options.find((o) => /united states|usa|u\.s\./i.test(o.trim())) || field.options[0])
        : targetVal;
      log.info(`[Resolver] ✅ T1 ${field.label} → "${finalVal}"`);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: finalVal,
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
      };
    }

    const tier1 = await resolveTier1(applywizzId, field, profile);
    if (tier1) {
      log.info(`[Resolver] ✅ T1 ${field.label} → "${tier1.value}"`);
      return tier1;
    }
    log.info(`[Resolver] ❌ T1 ${field.label} — no profile match`);

    if (!isRequired) {
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        label: field.label,
        value: '',
        source: 'supabase',
        resolvedByTier: 1,
        confidence: 1.0,
      };
    }

    const parsedResume =
      context.parsedResume !== undefined
        ? context.parsedResume
        : await getOrParseResume(applywizzId);

    const tier2 = await resolveTier2(applywizzId, field, parsedResume);
    if (tier2) {
      log.info(`[Resolver] ✅ T2 ${field.label} → "${tier2.value}"`);
      return tier2;
    }
    log.info(`[Resolver] ❌ T2 ${field.label} — no resume match`);

    // ------------------------------------------------------------------------
    // Tier 3: Semantic Search (vector embedding match against candidate_qa_bank)
    // ------------------------------------------------------------------------
    const semanticMatch = await findSemanticMatch(field.label, applywizzId, field.type);
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
      };
    }
    const t3Score = getLastSemanticScore().toFixed(2);
    log.info(`[Resolver] ❌ T3 ${field.label} — below similarity threshold (${t3Score})`);

    // ------------------------------------------------------------------------
    // Tier 4: Fuse.js Fuzzy Match against candidate_qa_bank
    // ------------------------------------------------------------------------
    const tier4 = await resolveTier3(applywizzId, field, context.qaEntries);
    if (tier4) {
      log.info(`[Resolver] ✅ T4 ${field.label} → "${tier4.value}"`);
      return {
        ...tier4,
        resolvedByTier: 4,
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
          resolvedFields[chunkSlots[i]] = tier5;
          log.info(`[Resolver] ✅ T5 ${chunkFields[i].label} → "${tier5.value}"`);
        } else {
          const reason = getTier5FailureReason(chunkFields[i]);
          log.info(`[Resolver] ❌ T5 ${chunkFields[i].label} — ${reason}`);
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
          log.info(
            `[Resolver] ⏭️ Skipping candidate_applications upsert for ${seg.applywizzId} ${persistJobUrl} — no scan template`
          );
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
            await upsertApplication({
              applywizz_id: app.applywizzId,
              job_url: persistJobUrl,
              company_name: app.companyName,
              job_title: app.jobTitle,
              resolved_fields: app.resolvedFields,
              csv_job_score: parseScoreFromJob(job.score),
              field_count: questionCount,
              assigned_ca_email: app.assignedCaEmail || (seg as any).assignedCaEmail || seg.profile?.ca_email || null,
            });
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

        if (!compact) {
          const counts = { supabase: 0, resume: 0, semantic: 0, fuzzy: 0, llm: 0, unresolved: 0, other: 0 };
          for (const f of app.resolvedFields) {
            counts[resolutionSourceKey(f)]++;
          }
          log.info(
            `[Answer Resolver] [${resolvedCount}] ✅ ${app.candidateName} -> ${app.companyName} [Supabase:${counts.supabase} Resume:${counts.resume} Semantic:${counts.semantic} Fuzzy:${counts.fuzzy} LLM:${counts.llm} Unresolved:${counts.unresolved}]`
          );
        }
      }
    };

    await Promise.all(Array.from({ length: poolSize }, () => processResolveTask()));

    for (const seg of segments) {
      const stats = segStats.get(seg.applywizzId)!;
      if (compact && stats.total > 0) {
        log.info(
          `[Answer Resolver] ${seg.applywizzId} resolved successful=${stats.successful} unsuccessful=${stats.unsuccessful} no_template=${stats.noTemplate} failed=${stats.failed}`
        );
      }
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
