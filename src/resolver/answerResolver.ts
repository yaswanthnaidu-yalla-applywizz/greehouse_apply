/**
 * @fileoverview 5-Tier Answer Resolution Engine Orchestrator (Greenhouse V2).
 *
 * Coordinates Tiers 1 through 5 in strict waterfall sequence:
 * - Tier 1: Supabase profiles + exact candidate_qa_bank match (source: 'supabase', tier: 1)
 * - Tier 2: Parsed resume cache / pdf-parse extraction (source: 'resume_parse', tier: 2)
 * - Tier 3: Fuzzy Fuse.js match against candidate_qa_bank (source: 'fuzzy_match', tier: 3)
 * - Tier 4: ApplyWizz live API refetch + profile upsert + re-run Tier 1 (source: 'api', tier: 4)
 * - Tier 5: LLM synthesis + automatic QA bank writeback (source: 'ai', tier: 5)
 * - Fallback: Unresolved field (source: 'unresolved', tier: null)
 */

import fs from 'fs';
import path from 'path';
import config from '../config/env.js';
import { getProfile, type ProfileRow } from '../db/profiles.js';
import { findAnswersByCandidate, type QABankRow } from '../db/qaBank.js';
import { getOrParseResume, type ResumeParsedRow } from './tier2ResumeParse.js';
import { resolveTier1 } from './tier1Supabase.js';
import { resolveTier2 } from './tier2ResumeParse.js';
import { resolveTier3 } from './tier3FuzzyMatch.js';
import { resolveTier4 } from './tier4ApiRefetch.js';
import { resolveTier5 } from './tier5LLM.js';
import { resolveShortlink, resolveShortlinksBatch } from '../scanner/csvDeduplicator.js';
import type {
  ApplicationStatus,
  CandidateJobApplication,
  CandidateSegment,
  ResolvedField,
  ScannedField,
  ScannedJobTemplate,
} from '../types/index.js';

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
 * Orchestrator running the 5-tier waterfall resolution engine.
 */
export class AnswerResolver {
  /**
   * Resolves a single scanned form field through the 5-tier waterfall.
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

    // ------------------------------------------------------------------------
    // Tier 1: Supabase Profile & Exact QA Bank
    // ------------------------------------------------------------------------
    const tier1 = await resolveTier1(applywizzId, field, profile);
    if (tier1) {
      return tier1;
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
    // Tier 3: Fuzzy Match against candidate_qa_bank
    // ------------------------------------------------------------------------
    const tier3 = await resolveTier3(applywizzId, field, context?.qaEntries);
    if (tier3) {
      return tier3;
    }

    // ------------------------------------------------------------------------
    // Tier 4: ApplyWizz Live API Refetch
    // ------------------------------------------------------------------------
    const tier4 = await resolveTier4(applywizzId, field);
    if (tier4) {
      return tier4;
    }

    // ------------------------------------------------------------------------
    // Tier 5: LLM Synthesis with QA Bank Writeback
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

    for (const field of template.fields) {
      const resolved = await this.resolveField(applywizzId, field, {
        profile,
        parsedResume,
        qaEntries,
        jobContext,
      });
      resolvedFields.push(resolved);
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
      `[Answer Resolver] 🚀 Resolving answers across ${segments.length} candidates and ${totalPairs} job assignments using 5-tier waterfall...`
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

        const t1 = app.resolvedFields.filter((f) => f.resolvedByTier === 1).length;
        const t2 = app.resolvedFields.filter((f) => f.resolvedByTier === 2).length;
        const t3 = app.resolvedFields.filter((f) => f.resolvedByTier === 3).length;
        const t4 = app.resolvedFields.filter((f) => f.resolvedByTier === 4).length;
        const t5 = app.resolvedFields.filter((f) => f.resolvedByTier === 5).length;
        const unres = app.resolvedFields.filter((f) => f.resolvedByTier === null).length;

        console.log(
          `[Answer Resolver] [${resolvedCount}] ✅ ${app.candidateName} -> ${app.companyName} [T1:${t1} T2:${t2} T3:${t3} T4:${t4} T5:${t5} Unres:${unres}]`
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
