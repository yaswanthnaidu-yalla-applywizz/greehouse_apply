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
import { readAndDeduplicateUrls, resolveShortlink, atsFromUrl } from '../scanner/csvDeduplicator.js';
import { PlaywrightScanner } from '../scanner/playwrightScanner.js';
import { exportScannedJobs } from '../scanner/exportScannedJobs.js';
import { scanAshbyJob } from '../scanner/ashbyScanner.js';
import { segregateCandidatesByApplyWizzId, exportCandidateSegments } from '../candidate/segregator.js';
import { syncCaCandidateAssignments } from '../services/caAssignmentSync.js';
import { getSandboxCaEmail } from '../db/sandboxAssignment.js';
import { AnswerResolver, exportResolvedApplications } from '../resolver/answerResolver.js';
import { sendCaNotificationEmails, sendLeadershipIngestionSummary } from '../services/caNotificationEmail.js';
import { sendEmail } from '../services/azureEmail.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  IngestFilterApplication,
  IngestFilterReport,
  ScannedJobTemplate,
} from '../types/index.js';
import { hasSecurityClearanceQuestion } from '../scanner/securityClearance.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import { isPipelineAbortedError, resetPipelineAbort, throwIfPipelineAborted } from './pipelineAbort.js';

const log = createLogger('Pipeline');

function addUniqueIngestFilterApplication(
  applications: IngestFilterApplication[],
  application: IngestFilterApplication
): void {
  if (!applications.some((item) =>
    item.applywizzId.toUpperCase() === application.applywizzId.toUpperCase() &&
    item.jobUrl === application.jobUrl
  )) {
    applications.push(application);
  }
}

/**
 * Aligns candidate segment jobs with scanned unique URLs.
 * Resolves any grnh.se shortlinks (using Phase A's pre-warmed cache) so
 * candidate jobs match canonical URLs, then filters to scanned URLs.
 */
export async function alignAndFilterCandidateSegmentJobs(
  candidateSegments: Iterable<CandidateSegment>,
  allowedJobUrls: Set<string>,
  resolveShortlinkFn: (url: string) => Promise<string> = resolveShortlink
): Promise<void> {
  for (const segment of candidateSegments) {
    for (const job of segment.jobs) {
      if (job.canonicalUrl && job.canonicalUrl.includes('grnh.se')) {
        job.canonicalUrl = await resolveShortlinkFn(job.canonicalUrl);
      }
    }
    segment.jobs = segment.jobs.filter(
      (j) => allowedJobUrls.has(j.canonicalUrl) || (j.rawUrl && allowedJobUrls.has(j.rawUrl))
    );
    segment.totalJobs = segment.jobs.length;
  }
}

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
  ingestFilterReport: IngestFilterReport;
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

    const compact = isPipelineCompactLogging();
    if (compact) {
      log.info(
        `[Pipeline] start csv=${resolvedCsvPath} output=${resolvedOutputDir} limit=${options.limit ?? 'all'} llm=${config.LLM_PROVIDER}`
      );
    } else {
      log.info('================================================================');
      log.info('  🟢 Greenhouse Automation V1: End-to-End Master Pipeline');
      log.info('================================================================');
      log.info(`• Input CSV:      ${resolvedCsvPath}`);
      log.info(`• Output Dir:     ${resolvedOutputDir}`);
      log.info(`• Row Limit:      ${options.limit ? options.limit : 'All rows'}`);
      log.info(`• LLM Provider:   ${config.LLM_PROVIDER}`);
      log.info(`• LLM Model:      ${config.OPENROUTER_MODEL || 'default'}`);
      log.info('================================================================\n');
    }

    resetPipelineAbort();

    let uniqueUrls: string[] = [];
    let scannedTemplates: ScannedJobTemplate[] = [];
    let candidateSegments: CandidateSegment[] = [];
    let resolvedApplications: CandidateJobApplication[] = [];
    const ingestFilterReport: IngestFilterReport = {
      clearanceLinks: [],
      excludedCompanyApplications: [],
      latestEmployerApplications: [],
      filteredOutApplications: [],
    };

    // -------------------------------------------------------------
    // Phase A: Ingestion & URL Deduplication (Branch 1)
    // -------------------------------------------------------------
    if (!compact) log.info('[Pipeline Phase A] 🔍 Stream-parsing CSV & deduplicating Greenhouse URLs...');
    try {
      uniqueUrls = await readAndDeduplicateUrls(resolvedCsvPath, {
        concurrency: 25,
      });
      if (options.limit && options.limit > 0 && uniqueUrls.length > options.limit) {
        uniqueUrls = uniqueUrls.slice(0, options.limit);
      }
      if (compact) {
        log.info(`[Pipeline] phase A done unique_urls=${uniqueUrls.length}`);
      } else {
        const cap = options.limit && options.limit > 0 ? ` (capped at ${options.limit})` : '';
        log.info(`[Pipeline Phase A] ✅ Extracted ${uniqueUrls.length} unique canonical Greenhouse URLs${cap}.\n`);
      }
    } catch (err: any) {
      haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed', err);
    }
    throwIfPipelineAborted('Phase A');

    // -------------------------------------------------------------
    // Phase B: Headless Playwright DOM Scanning (Branch 1)
    // -------------------------------------------------------------
    const scannedJsonPath = path.join(resolvedOutputDir, 'scanned_jobs.json');
    if (options.skipScanIfCached && fs.existsSync(scannedJsonPath)) {
      if (compact) log.info('[Pipeline Phase B] using cached scanned_jobs.json');
      else log.info('[Pipeline Phase B] ⚡ Found existing scanned_jobs.json cache, skipping browser scan.');
      try {
        const raw = await fs.promises.readFile(scannedJsonPath, 'utf-8');
        scannedTemplates = JSON.parse(raw);
        log.info(`[Pipeline Phase B] cache templates=${scannedTemplates.length}`);
      } catch {
        // Fall back to scanning if read fails
      }
    }

    if (scannedTemplates.length === 0) {
      const scanWorkers = options.concurrency ?? config.WORKER_POOL_SIZE;
      if (compact) {
        log.info(`[Pipeline] phase B scan start urls=${uniqueUrls.length} workers=${scanWorkers}`);
      } else {
        log.info(`[Pipeline Phase B] 🌐 Scanning ${uniqueUrls.length} unique URLs with Playwright pool...`);
      }
      let scanCompleted = false;
      let scannedCount = 0;
      let scanFailures = 0;
      const reportScanProgress = (): void => {
        if (scannedCount === uniqueUrls.length || scannedCount % 25 === 0) {
          log.info(
            `[Pipeline Phase B] Progress: ${scannedCount}/${uniqueUrls.length} scanned | Success: ${scannedCount - scanFailures}, Failed: ${scanFailures}`
          );
        }
      };
      try {
        const scanner = new PlaywrightScanner({
          workerPoolSize: scanWorkers,
          timeoutMs: config.PLAYWRIGHT_TIMEOUT,
          minJitterMs: config.SCANNER_JITTER_MIN_MS,
          maxJitterMs: config.SCANNER_JITTER_MAX_MS,
          onJobScanned: () => {
            scannedCount++;
            reportScanProgress();
          },
        });

        const ashbyUrls = uniqueUrls.filter((u) => atsFromUrl(u) === 'ashby');
        const greenhouseUrls = uniqueUrls.filter((u) => atsFromUrl(u) !== 'ashby');
        const ghTemplates = greenhouseUrls.length > 0 ? await scanner.scanUniqueUrls(greenhouseUrls) : [];
        const ashbyTemplates: ScannedJobTemplate[] = [];
        for (const aUrl of ashbyUrls) {
          try {
            const tmpl = await scanAshbyJob(aUrl);
            ashbyTemplates.push(tmpl);
          } catch (e: any) {
            scanFailures++;
            log.warn(`[Pipeline] Ashby scan failed for ${aUrl}: ${e.message}`);
          } finally {
            scannedCount++;
            reportScanProgress();
          }
        }
        scannedTemplates = [...ghTemplates, ...ashbyTemplates];
        scanCompleted = true;
      } catch (err: any) {
        if (isPipelineAbortedError(err)) {
          throw err;
        }
        log.warn(`[Pipeline Phase B] ⚠️ Playwright scan encountered non-fatal error: ${err.message}. Continuing.`);
      }

      if (scanCompleted) {
        await exportScannedJobs(scannedTemplates, resolvedOutputDir);
        const greenhouseCount = scannedTemplates.filter((template) => atsFromUrl(template.jobUrl) === 'greenhouse').length;
        const ashbyCount = scannedTemplates.length - greenhouseCount;
        try {
          await sendEmail({
            to: 'yaswanthnaiduyalla@applywizz.ai',
            subject: 'ApplyWizz job scanning complete',
            text: `Scanned ${scannedCount}/${uniqueUrls.length} job URLs. Greenhouse: ${greenhouseCount}. Ashby: ${ashbyCount}. Failed: ${scanFailures}.`,
          });
        } catch (emailErr: any) {
          log.warn(`[Pipeline Phase B] Scan-complete email failed: ${emailErr?.message || emailErr}`);
        }
        if (compact) {
          log.info(`[Pipeline] phase B done templates=${scannedTemplates.length}`);
        } else {
          log.info(`[Pipeline Phase B] ✅ Successfully scanned ${scannedTemplates.length} job form schemas.\n`);
        }
      }
    }
    throwIfPipelineAborted('Phase B');
    ingestFilterReport.clearanceLinks = Array.from(new Set(
      scannedTemplates.filter(hasSecurityClearanceQuestion).map((template) => template.jobUrl)
    ));

    // -------------------------------------------------------------
    // Phase C: Candidate Segregation & Profile Sync (Branch 2)
    // -------------------------------------------------------------
    if (compact) {
      log.info('[Pipeline] phase C segregate start');
    } else {
      log.info('[Pipeline Phase C] 👥 Segregating candidates & syncing ApplyWizz profiles...');
    }
    try {
      const allowedJobUrls = new Set(uniqueUrls);
      const candidateMap = await segregateCandidatesByApplyWizzId(resolvedCsvPath, {
        limit: options.limit,
        concurrency: 10,
        syncProfiles: true,
        downloadResumes: true,
        // CSV IDs are an explicit ingest request — fetch missing profiles so application upserts can satisfy the FK.
        allowOutboundApi: true,
      });

      // Filter candidate segment jobs to only those present in scanned uniqueUrls
      await alignAndFilterCandidateSegmentJobs(candidateMap.values(), allowedJobUrls);

      await exportCandidateSegments(candidateMap, resolvedOutputDir);
      candidateSegments = Array.from(candidateMap.values());
      if (compact) {
        log.info(`[Pipeline] phase C done candidates=${candidateSegments.length}`);
      } else {
        log.info(`[Pipeline Phase C] ✅ Synced ${candidateSegments.length} candidate profiles and master resumes.\n`);
      }
    } catch (err: any) {
      log.error(`[Pipeline Phase C] ❌ Failed during candidate sync: ${err.message}`);
      throw err;
    }

    throwIfPipelineAborted('Phase C');

    // -------------------------------------------------------------
    // Phase B.5: CA Assignment Sync
    // -------------------------------------------------------------
    log.info('[Pipeline] Phase B.5 — CA assignment sync');
    try {
      const allApplywizzIds = candidateSegments.map((c) => c.applywizzId);
      const sandboxCaEmail = getSandboxCaEmail();
      const syncResult = await syncCaCandidateAssignments({ applywizzIds: allApplywizzIds });
      const caEmailMap = syncResult.mappingMap;

      let mappedCount = 0;
      for (const segment of candidateSegments) {
        const caEmail = sandboxCaEmail || caEmailMap.get(segment.applywizzId.toUpperCase()) || segment.profile?.ca_email || null;
        if (caEmail) {
          if (segment.profile) {
            segment.profile.ca_email = caEmail;
          }
          (segment as any).assignedCaEmail = caEmail;
          mappedCount++;
        }
      }
      log.info(`[Pipeline] Phase B.5 complete — synced CA assignments for ${mappedCount}/${candidateSegments.length} candidates (source=${syncResult.source})`);
    } catch (caErr: any) {
      log.warn(`[Pipeline] ⚠️ Phase B.5 warning: ${caErr.message}`);
    }

    throwIfPipelineAborted('Phase B.5');

    // -------------------------------------------------------------
    // Phase D: Multi-Tier Answer Resolution Engine
    // -------------------------------------------------------------
    const resolveJobCount = candidateSegments.reduce((sum, c) => sum + c.jobs.length, 0);
    if (compact) {
      log.info(
        `[Pipeline] phase D resolve start candidates=${candidateSegments.length} job_assignments=${resolveJobCount}`
      );
    } else {
      log.info('[Pipeline Phase D] 🧠 Resolving form answers (supabase vs ai)...');
    }
    try {
      resolvedApplications = await this.resolver.resolveAllApplications(
        candidateSegments,
        scannedTemplates,
        {
          onFilteredApplication: (application, reason) => {
            const rows = reason === 'excluded_company'
              ? ingestFilterReport.excludedCompanyApplications
              : reason === 'latest_employer'
              ? ingestFilterReport.latestEmployerApplications
              : ingestFilterReport.filteredOutApplications;
            addUniqueIngestFilterApplication(rows, application);
          },
        }
      );

      await exportResolvedApplications(resolvedApplications, resolvedOutputDir);
      if (compact) {
        log.info(`[Pipeline] phase D done applications=${resolvedApplications.length}`);
      } else {
        log.info(`[Pipeline Phase D] ✅ Resolved ${resolvedApplications.length} candidate job applications.\n`);
      }
    } catch (err: any) {
      log.error(`[Pipeline Phase D] ❌ Error during answer resolution: ${err.message}`);
      throw err;
    }
    throwIfPipelineAborted('Phase D');

    try {
      const runStartedAt = new Date(startTime).toISOString();
      const pendingAutoQueue = this.resolver.getPendingAutoQueue();
      const excludeKeys = new Set(pendingAutoQueue.map((p) => `${p.applywizzId.trim().toUpperCase()}::${p.jobUrl}`));
      await sendCaNotificationEmails(runStartedAt, { excludeKeys });
      await sendLeadershipIngestionSummary(runStartedAt, { excludeKeys });
    } catch (caEmailErr: any) {
      log.warn(`[Pipeline Phase D] ⚠️ CA/Leadership notification email error: ${caEmailErr?.message || caEmailErr}`);
    }

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
      ingestFilterReport,
      durationMs,
      status: resolvedApplications.length > 0 ? 'SUCCESS' : 'PARTIAL',
      outputFiles: {
        scannedJobsJson: path.join(resolvedOutputDir, 'scanned_jobs.json'),
        scannedJobsCsv: path.join(resolvedOutputDir, 'scanned_jobs.csv'),
        candidateSegmentsJson: path.join(resolvedOutputDir, 'candidate_segments.json'),
        resolvedApplicationsJson: path.join(resolvedOutputDir, 'resolved_applications.json'),
      },
    };

    if (compact) {
      log.info(
        `[Pipeline] complete duration=${elapsedSec}s candidates=${result.uniqueCandidates} urls=${result.uniqueUrls} applications=${result.resolvedApplications} fields=${result.scannedFields} supabase_fields=${supabaseCount} ai_fields=${aiCount} status=${result.status}`
      );
    } else {
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
    }

    // -------------------------------------------------------------
    // Post-Ingest Auto-Queue Flush
    // -------------------------------------------------------------
    if (this.resolver.getPendingAutoQueueCount() > 0) {
      const count = this.resolver.getPendingAutoQueueCount();
      log.info(`[Pipeline] Ingest run complete — flushing ${count} auto-queued applications...`);
      const enqueued = await this.resolver.flushPendingAutoQueue();
      log.info(`[Pipeline] ✅ Successfully auto-queued ${enqueued}/${count} applications for submission.`);
    }

    return result;
  }
}
