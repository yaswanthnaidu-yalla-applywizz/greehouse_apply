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
import { resolveTier5 } from './tier5LLM.js';
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
export function resolutionSourceKey(resolved: ResolvedField): 'supabase' | 'resume' | 'llm' | 'unresolved' | 'other' {
  if (resolved.source === 'unresolved' || resolved.resolvedByTier === null) return 'unresolved';
  if (resolved.source === 'resume_parse' || resolved.resolvedByTier === 2) return 'resume';
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
    // Tier 1: Supabase Profile & Exact QA Bank
    // ------------------------------------------------------------------------
    const tier1 = await resolveTier1(applywizzId, field, profile);
    if (tier1) {
      return tier1;
    }

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
      return tier2;
    }

    // ------------------------------------------------------------------------
    // Tier 5: Local LLM Synthesis with QA Bank Writeback
    // Streamlined Flow: Supabase ➔ Resume Parse (Supabase Storage) ➔ Local Ollama LLM
    // ------------------------------------------------------------------------
    if (profile) {
      const tier5 = await resolveTier5(
        applywizzId,
        field,
        profile,
        jobContext,
        parsedResume?.raw_text || ''
      );
      if (tier5) {
        return tier5;
      }
    }

    // ------------------------------------------------------------------------
    // Fallback: Unresolved Field
    // ------------------------------------------------------------------------
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
      };
    }

    const resolvedFields: ResolvedField[] = [];
    console.log(`\n[Answer Resolver] 👤 Resolving [${candidateName}] for "${template.jobTitle}" at "${template.companyName}" (${template.fields.length} questions)...`);

    for (const field of template.fields) {
      const resolved = await this.resolveField(applywizzId, field, {
        profile,
        parsedResume,
        qaEntries,
        jobContext,
      });
      resolvedFields.push(resolved);

      const preview = resolved.value
        ? (resolved.value.length > 35 ? resolved.value.slice(0, 32) + '...' : resolved.value)
        : '<blank>';
      console.log(`  • [${formatResolutionSource(resolved)}] "${field.label}" ➔ "${preview}"`);
    }

    return {
      applywizzId,
      candidateName,
      jobUrl: template.jobUrl,
      companyName: template.companyName || '',
      jobTitle: template.jobTitle || '',
      status: 'READY_FOR_REVIEW' as ApplicationStatus,
      resolvedFields,
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

    console.log(
      `[Answer Resolver] 🚀 Resolving answers across ${segments.length} candidates and ${totalPairs} job assignments (Supabase → Resume → LLM)...`
    );

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

    let resolvedCount = 0;

    for (const seg of segments) {
      for (const job of seg.jobs) {
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

        if (!template) continue;

        const questionCount = template.fields?.length || 0;
        if (questionCount >= config.MAX_JOB_QUESTIONS) {
          continue;
        }

        const app = await this.resolveJobApplication(seg.applywizzId, template);
        applications.push(app);
        resolvedCount++;

        // Persist resolved application record to Supabase (candidate_applications table)
        try {
          await upsertApplication({
            applywizz_id: app.applywizzId,
            job_url: app.jobUrl,
            company_name: app.companyName,
            job_title: app.jobTitle,
            resolved_fields: app.resolvedFields,
          });
        } catch (dbErr: any) {
          console.warn(`[Answer Resolver] ⚠️ Could not upsert candidate_applications: ${dbErr.message}`);
        }

        const counts = { supabase: 0, resume: 0, llm: 0, unresolved: 0, other: 0 };
        for (const f of app.resolvedFields) {
          counts[resolutionSourceKey(f)]++;
        }

        console.log(
          `[Answer Resolver] [${resolvedCount}] ✅ ${app.candidateName} -> ${app.companyName} [Supabase:${counts.supabase} Resume:${counts.resume} LLM:${counts.llm} Unresolved:${counts.unresolved}]`
        );
      }
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
