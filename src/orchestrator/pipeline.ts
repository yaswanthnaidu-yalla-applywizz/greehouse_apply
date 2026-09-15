/**
 * @fileoverview End-to-End Master Pipeline Orchestrator (Phase V1-6).
 *
 * Coordinates the full Greenhouse Job Application Automation workflow in sequence:
 *   a) Ingestion & URL Canonicalization (CSV Deduplicator)
 *   b) Unique Link Form Scanning (Playwright Scanner)
 *   c) Candidate Segregation & Profile Sync (ApplyWizz Client + Resume Downloader)
 *   d) Multi-Tier Answer Resolution Engine (Profile Matcher + LLM Synthesizer + Q&A Bank)
 *   e) Comprehensive Metrics Aggregation and JSON/CSV Artifact Export
 *
 * References:
 * - 02-trd.md (Section 1)
 * - 03-workflow.md (End-to-End Execution Flow)
 * - 06-implementation.md (Phase V1-6)
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { readAndDeduplicateUrls } from '../scanner/csvDeduplicator.js';
import { PlaywrightScanner } from '../scanner/playwrightScanner.js';
import { exportScannedJobs } from '../scanner/exportScannedJobs.js';
import {
  segregateCandidatesByApplyWizzId,
  exportCandidateSegments,
  ensureApplicationRowsFromCsv,
} from '../candidate/segregator.js';
import { AnswerResolver, exportResolvedApplications } from '../resolver/answerResolver.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedJobTemplate,
} from '../types/index.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import { resetPipelineAbort, throwIfPipelineAborted } from './pipelineAbort.js';

const log = createLogger('Pipeline');

/**
 * Options configuring the End-to-End V1Pipeline execution.
 */
export interface PipelineOptions {
  /** Maximum number of CSV rows to process (useful for rapid sample verification) */
  limit?: number;
  /** Parallel Playwright browser worker pool size */
  concurrency?: number;
  /** Skip Playwright scanning if valid scanned_jobs.json already exists */
  skipScanIfCached?: boolean;
  /** Custom output directory override */
  outputDir?: string;
  /** Custom resumes directory override */
  resumesDir?: string;
}

/**
 * Aggregated execution metrics and output artifact paths returned by the pipeline.
 */
export interface PipelineResult {
  totalRows: number;
  uniqueCandidates: number;
  uniqueUrls: number;
  scannedFields: number;
  resolvedApplications: number;
  deferredApplications?: number;
  maxQuestionThreshold?: number;
  supabaseTaggedCount: number;
  aiTaggedCount: number;
  durationMs: number;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  outputFiles: {
    scannedJobsJson: string;
    scannedJobsCsv: string;
    candidateSegmentsJson: string;
    resolvedApplicationsJson: string;
  };
}

/**
 * End-to-End Pipeline Orchestrator coordinating all automation phases.
 */
export class V1Pipeline {
  private readonly resolver: AnswerResolver;

  /**
   * Initializes the pipeline orchestrator with subsystem handlers.
   */
  constructor() {
    this.resolver = new AnswerResolver();
  }

  /**
   * Executes the entire automation pipeline end-to-end.
   *
   * @param inputCsvPath - Path to the input job assignments CSV.
   * @param outputDir - Destination directory for output artifacts.
   * @param options - Configurable pipeline execution options.
   * @returns Comprehensive PipelineResult summary.
   */
  public async runFullPipeline(
    inputCsvPath: string = config.INPUT_CSV_PATH,
    outputDir: string = config.OUTPUT_DIR,
    options: PipelineOptions = {}
  ): Promise<PipelineResult> {
    const startTime = Date.now();
    const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
    const resolvedCsvPath = path.resolve(process.cwd(), inputCsvPath);

    if (!fs.existsSync(resolvedOutputDir)) {
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
    }

    if (!fs.existsSync(resolvedCsvPath)) {
      throw new Error(`Input CSV file does not exist at: "${resolvedCsvPath}".`);
    }

    log.info('================================================================');
    log.info('  🟢 Greenhouse Automation V1: End-to-End Master Pipeline');
    log.info('================================================================');
    log.info(`• Input CSV:      ${resolvedCsvPath}`);
    log.info(`• Output Dir:     ${resolvedOutputDir}`);
    log.info(`• Row Limit:      ${options.limit ? options.limit : 'All rows'}`);
    log.info(`• LLM Provider:   ${config.LLM_PROVIDER}`);
    log.info(`• LLM Model:      ${config.OPENROUTER_MODEL || 'default'}`);
    log.info('================================================================\n');

    resetPipelineAbort();

    let uniqueUrls: string[] = [];
    let scannedTemplates: ScannedJobTemplate[] = [];
    let candidateSegments: CandidateSegment[] = [];
    let resolvedApplications: CandidateJobApplication[] = [];

    // -------------------------------------------------------------
    // Phase A: Ingestion & URL Deduplication (Branch 1)
    // -------------------------------------------------------------
    log.info('[Pipeline Phase A] 🔍 Stream-parsing CSV & deduplicating Greenhouse URLs...');
    try {
      uniqueUrls = await readAndDeduplicateUrls(resolvedCsvPath, {
        limit: options.limit,
        concurrency: 25,
      });
      log.info(`[Pipeline Phase A] ✅ Extracted ${uniqueUrls.length} unique canonical Greenhouse URLs.\n`);
    } catch (err: any) {
      haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed', err);
    }
    throwIfPipelineAborted('Phase A');

    // -------------------------------------------------------------
    // Phase B: Headless Playwright DOM Scanning (Branch 1)
    // -------------------------------------------------------------
    const scannedJsonPath = path.join(resolvedOutputDir, 'scanned_jobs.json');
    if (options.skipScanIfCached && fs.existsSync(scannedJsonPath)) {
      log.info('[Pipeline Phase B] ⚡ Found existing scanned_jobs.json cache, skipping browser scan.');
      try {
        const raw = await fs.promises.readFile(scannedJsonPath, 'utf-8');
        scannedTemplates = JSON.parse(raw);
        log.info(`[Pipeline Phase B] ✅ Loaded ${scannedTemplates.length} cached job templates.\n`);
      } catch {
        // Fall back to scanning if read fails
      }
    }

    if (scannedTemplates.length === 0) {
      log.info(`[Pipeline Phase B] 🌐 Scanning ${uniqueUrls.length} unique URLs with Playwright pool...`);
      try {
        const scanner = new PlaywrightScanner({
          workerPoolSize: options.concurrency ?? config.WORKER_POOL_SIZE,
          timeoutMs: config.PLAYWRIGHT_TIMEOUT,
          minJitterMs: config.SCANNER_JITTER_MIN_MS,
          maxJitterMs: config.SCANNER_JITTER_MAX_MS,
        });

        scannedTemplates = await scanner.scanUniqueUrls(uniqueUrls);
        await exportScannedJobs(scannedTemplates, resolvedOutputDir);
        log.info(`[Pipeline Phase B] ✅ Successfully scanned ${scannedTemplates.length} job form schemas.\n`);
      } catch (err: any) {
        log.warn(`[Pipeline Phase B] ⚠️ Playwright scan encountered non-fatal error: ${err.message}. Continuing.`);
      }
    }
    throwIfPipelineAborted('Phase B');

    // -------------------------------------------------------------
    // Phase C: Candidate Segregation & Profile Sync (Branch 2)
    // -------------------------------------------------------------
    log.info('[Pipeline Phase C] 👥 Segregating candidates & syncing ApplyWizz profiles...');
    try {
      const candidateMap = await segregateCandidatesByApplyWizzId(resolvedCsvPath, {
        limit: options.limit,
        concurrency: 10,
        syncProfiles: true,
        downloadResumes: true,
        // CSV IDs are an explicit ingest request — fetch missing profiles so application upserts can satisfy the FK.
        allowOutboundApi: true,
      });

      await exportCandidateSegments(candidateMap, resolvedOutputDir);
      candidateSegments = Array.from(candidateMap.values());
      log.info(`[Pipeline Phase C] ✅ Synced ${candidateSegments.length} candidate profiles and master resumes.\n`);
    } catch (err: any) {
      log.error(`[Pipeline Phase C] ❌ Failed during candidate sync: ${err.message}`);
      throw err;
    }

    // Post-segregator safety net: every CSV job row → candidate_applications (templates now in DB from Phase B).
    try {
      await ensureApplicationRowsFromCsv(resolvedCsvPath, {
        limit: options.limit,
      });
    } catch (err: any) {
      log.warn(`[Pipeline Phase C] ⚠️ ensureApplicationRowsFromCsv: ${err.message}`);
    }
    throwIfPipelineAborted('Phase C');

    // -------------------------------------------------------------
    // Phase D: Multi-Tier Answer Resolution Engine
    // -------------------------------------------------------------
    log.info('[Pipeline Phase D] 🧠 Resolving form answers (supabase vs ai)...');
    try {
      resolvedApplications = await this.resolver.resolveAllApplications(
        candidateSegments,
        scannedTemplates
      );

      await exportResolvedApplications(resolvedApplications, resolvedOutputDir);
      log.info(`[Pipeline Phase D] ✅ Resolved ${resolvedApplications.length} candidate job applications.\n`);
    } catch (err: any) {
      log.error(`[Pipeline Phase D] ❌ Error during answer resolution: ${err.message}`);
      throw err;
    }
    throwIfPipelineAborted('Phase D');

    // -------------------------------------------------------------
    // Phase E: Aggregation & Summary Metrics
    // -------------------------------------------------------------
    let totalFields = 0;
    let supabaseCount = 0;
    let aiCount = 0;

    for (const app of resolvedApplications) {
      for (const f of app.resolvedFields) {
        totalFields++;
        if (f.source === 'supabase') supabaseCount++;
        if (f.source === 'ai') aiCount++;
      }
    }

    const durationMs = Date.now() - startTime;
    const elapsedSec = (durationMs / 1000).toFixed(1);

    const result: PipelineResult = {
      totalRows: candidateSegments.reduce((sum, c) => sum + c.totalJobs, 0),
      uniqueCandidates: candidateSegments.length,
      uniqueUrls: uniqueUrls.length,
      scannedFields: totalFields,
      resolvedApplications: resolvedApplications.length,
      maxQuestionThreshold: config.MAX_JOB_QUESTIONS,
      supabaseTaggedCount: supabaseCount,
      aiTaggedCount: aiCount,
      durationMs,
      status: resolvedApplications.length > 0 ? 'SUCCESS' : 'PARTIAL',
      outputFiles: {
        scannedJobsJson: path.join(resolvedOutputDir, 'scanned_jobs.json'),
        scannedJobsCsv: path.join(resolvedOutputDir, 'scanned_jobs.csv'),
        candidateSegmentsJson: path.join(resolvedOutputDir, 'candidate_segments.json'),
        resolvedApplicationsJson: path.join(resolvedOutputDir, 'resolved_applications.json'),
      },
    };

    log.info('================================================================');
    log.info('  🏁 End-to-End Pipeline Completed Successfully');
    log.info('================================================================');
    log.info(`• Duration:               ${elapsedSec}s`);
    log.info(`• Unique Candidates:      ${result.uniqueCandidates}`);
    log.info(`• Unique Job URLs:        ${result.uniqueUrls}`);
    log.info(`• Applications Ready:     ${result.resolvedApplications} (< ${config.MAX_JOB_QUESTIONS} questions)`);
    log.info(`• Total Fields Populated: ${result.scannedFields}`);
    log.info(`  - 🟢 'supabase' Tagged: ${supabaseCount} (${totalFields ? ((supabaseCount / totalFields) * 100).toFixed(1) : 0}%)`);
    log.info(`  - 🟣 'ai' Tagged:       ${aiCount} (${totalFields ? ((aiCount / totalFields) * 100).toFixed(1) : 0}%)`);
    log.info(`• Output Files:`);
    log.info(`  - ${result.outputFiles.scannedJobsJson}`);
    log.info(`  - ${result.outputFiles.scannedJobsCsv}`);
    log.info(`  - ${result.outputFiles.candidateSegmentsJson}`);
    log.info(`  - ${result.outputFiles.resolvedApplicationsJson}`);
    log.info('================================================================\n');

    return result;
  }
}
