/**
 * @fileoverview Multi-Tier Answer Resolution Engine (Branch 2).
 *
 * Coordinates Tier 1 (`supabase` profile & local database matching) and Tier 2 (`ai` LLM synthesis)
 * to populate complete `CandidateJobApplication` records ready for operator review.
 *
 * References:
 * - 02-trd.md (Section 3.4)
 * - 03-workflow.md (Step 4)
 * - 05-backend-schema.md (Section 1.4)
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { resolveShortlink, resolveShortlinksBatch } from '../scanner/csvDeduplicator.js';
import { ProfileMatcher } from './profileMatcher.js';
import { LLMSynthesizer } from './llmSynthesizer.js';
import { QABank } from './qaBank.js';
import type {
  ApplyWizzCandidateProfile,
  CandidateJobApplication,
  CandidateSegment,
  ResolvedField,
  ScannedJobTemplate,
} from '../types/index.js';

/**
 * Orchestrator resolving application questions for candidate-job pairings.
 */
export class AnswerResolver {
  private readonly profileMatcher: ProfileMatcher;
  private readonly llmSynthesizer: LLMSynthesizer;
  private readonly qaBank: QABank;

  /**
   * Initializes the AnswerResolver with matcher, synthesizer, and Q&A bank instances.
   *
   * @param matcher - Optional custom ProfileMatcher.
   * @param synthesizer - Optional custom LLMSynthesizer.
   * @param qaBank - Optional custom QABank.
   */
  constructor(
    matcher?: ProfileMatcher,
    synthesizer?: LLMSynthesizer,
    qaBank?: QABank
  ) {
    this.profileMatcher = matcher ?? new ProfileMatcher();
    this.llmSynthesizer = synthesizer ?? new LLMSynthesizer();
    this.qaBank = qaBank ?? new QABank();
  }

  /**
   * Resolves all form questions for a specific candidate and job posting template.
   *
   * @param applywizzId - Candidate identifier.
   * @param candidateProfile - Candidate details from ApplyWizz.
   * @param scanTemplate - Scanned form template from Playwright.
   * @param resumeText - Extracted plain text from resume PDF (optional).
   * @returns Complete CandidateJobApplication record.
   */
  public async resolveJobApplication(
    applywizzId: string,
    candidateProfile: ApplyWizzCandidateProfile,
    scanTemplate: ScannedJobTemplate,
    resumeText: string = ''
  ): Promise<CandidateJobApplication> {
    const candidateName = candidateProfile.clientName || applywizzId;

    // 1. Check if job is expired or closed
    if (scanTemplate.isExpired || !scanTemplate.fields || scanTemplate.fields.length === 0) {
      return {
        applywizzId,
        candidateName,
        jobUrl: scanTemplate.jobUrl,
        companyName: scanTemplate.companyName || '',
        jobTitle: scanTemplate.jobTitle || '',
        status: 'EXPIRED',
        resolvedFields: [],
      };
    }

    const resolvedFields: ResolvedField[] = [];
    const jobContext = {
      title: scanTemplate.jobTitle || 'Position',
      company: scanTemplate.companyName || 'Company',
    };

    // 2. Resolve each scanned form field
    for (const field of scanTemplate.fields) {
      // Tier 1: Direct / Fuzzy Match against Candidate Profile (source: 'supabase')
      const profileMatch = this.profileMatcher.resolveFromProfile(field, candidateProfile);
      if (profileMatch) {
        resolvedFields.push(profileMatch);
        this.qaBank.saveAnswer(applywizzId, profileMatch);
        continue;
      }

      // Check Persistent Q&A Bank for previously stored candidate answer (source: 'supabase')
      const cachedQA = this.qaBank.getAnswer(applywizzId, field.label, field.fieldId);
      if (cachedQA) {
        resolvedFields.push(cachedQA);
        continue;
      }

      // Tier 2: LLM Synthesis with Candidate + Resume + Job Context (source: 'ai')
      const aiResolution = await this.llmSynthesizer.synthesizeAnswer(
        field,
        candidateProfile,
        resumeText,
        jobContext
      );

      resolvedFields.push(aiResolution);
      this.qaBank.saveAnswer(applywizzId, aiResolution);
    }

    return {
      applywizzId,
      candidateName,
      jobUrl: scanTemplate.jobUrl,
      companyName: scanTemplate.companyName,
      jobTitle: scanTemplate.jobTitle,
      status: 'READY_FOR_REVIEW',
      resolvedFields,
    };
  }

  /**
   * Batch-resolves all assigned jobs for all candidate segments against available scanned templates.
   *
   * @param segments - Array of CandidateSegment records.
   * @param templates - Array of ScannedJobTemplate records.
   * @returns Array of resolved CandidateJobApplication records.
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
      `[Answer Resolver] 🚀 Resolving answers across ${segments.length} candidates and ${totalPairs} job assignments...`
    );

    // Pre-resolve all unique shortlinks in parallel batch
    const shortlinksToResolve = new Set<string>();
    for (const seg of segments) {
      for (const job of seg.jobs) {
        const u = job.canonicalUrl || job.rawUrl;
        if (u && u.includes('grnh.se')) {
          shortlinksToResolve.add(u);
        }
      }
    }

    if (shortlinksToResolve.size > 0) {
      console.log(`[Answer Resolver] 🔗 Pre-resolving ${shortlinksToResolve.size} unique shortlinks concurrently...`);
      await resolveShortlinksBatch(Array.from(shortlinksToResolve), 30);
    }

    let resolvedCount = 0;

    for (const seg of segments) {
      if (!seg.profile) {
        continue;
      }

      for (const job of seg.jobs) {
        let canonical = job.canonicalUrl || job.rawUrl;
        if (canonical.includes('grnh.se')) {
          canonical = await resolveShortlink(canonical);
        }

        // Find matching scanned template
        const template =
          templateMap.get(canonical) ||
          templateMap.get(job.canonicalUrl) ||
          templateMap.get(job.rawUrl) ||
          Array.from(templateMap.values()).find(
            (t) => t.jobUrl.includes(canonical) || canonical.includes(t.jobUrl)
          );

        if (!template) {
          applications.push({
            applywizzId: seg.applywizzId,
            candidateName: seg.clientName,
            jobUrl: canonical,
            companyName: '',
            jobTitle: '',
            status: 'PENDING',
            resolvedFields: [],
          });
          continue;
        }

        const app = await this.resolveJobApplication(
          seg.applywizzId,
          seg.profile,
          template
        );

        applications.push(app);
        resolvedCount++;

        const supabaseFields = app.resolvedFields.filter((f) => f.source === 'supabase').length;
        const aiFields = app.resolvedFields.filter((f) => f.source === 'ai').length;

        console.log(
          `[Answer Resolver] [${resolvedCount}] ✅ Resolved: ${app.candidateName} -> ${app.companyName} (${app.jobTitle}) [🟢 supabase: ${supabaseFields}, 🟣 ai: ${aiFields}]`
        );
      }
    }

    console.log(`[Answer Resolver] 🏁 Finished resolving ${resolvedCount} candidate job applications.`);
    return applications;
  }
}

/**
 * Serializes resolved candidate job applications to `output/resolved_applications.json`.
 *
 * @param applications - Array of CandidateJobApplication records.
 * @param outputDir - Destination directory (defaults to `config.OUTPUT_DIR` or `./output`).
 * @returns Promise resolving to the absolute output path.
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
  const stats = fs.statSync(jsonPath);

  console.log(
    `[Answer Resolver] 💾 Exported ${applications.length.toLocaleString()} resolved applications to: ${jsonPath} (${(stats.size / 1024).toFixed(1)} KB)`
  );

  return jsonPath;
}
