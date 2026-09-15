/**
 * @fileoverview Candidate Segregator and Batch Profile Synchronizer.
 *
 * Implements Branch 2 stream-parsing of `greenhouse_only_applywizz_prod(in).csv`, grouping records
 * by unique `Applywizz ID`, querying candidate profiles via `ApplyWizzClient`, downloading resumes,
 * and producing consolidated `CandidateSegment` mapping structures.
 *
 * References:
 * - 02-trd.md (Section 3.3)
 * - 03-workflow.md (Step 3)
 * - 05-backend-schema.md (Section 1.3)
 */

import fs from 'fs';
import path from 'path';
import * as fastCsv from 'fast-csv';
import { config } from '../config/env.js';
import { normalizeGreenhouseUrl } from '../scanner/csvDeduplicator.js';
import { ApplyWizzClient } from './applywizzClient.js';
import { profileRowToCandidateProfile } from '../db/profiles.js';
import { ensureApplicationRowsForSegment } from '../db/ensureCandidateApplicationRows.js';
import { ensureSupabaseProfile } from './ensureSupabaseProfile.js';
import type { CandidateSegment } from '../types/index.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import { throwIfPipelineAborted } from '../orchestrator/pipelineAbort.js';

const log = createLogger('Segregator');

export type CsvIngestFormat = 'OLD' | 'NEW' | 'UNKNOWN';

export interface ParsedCsvJobRow {
  applywizzId: string;
  clientName: string;
  rawUrl: string;
  date: string;
  score: number;
  scoredJobId: string;
  status: string;
}

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Detect CSV layout from header column names (first parsed row keys).
 */
export function detectCsvFormat(headerKeys: string[]): CsvIngestFormat {
  const normalized = new Set(headerKeys.map(normalizeHeaderKey));

  const hasNew =
    normalized.has('company_job_url') &&
    normalized.has('applywizz_id') &&
    normalized.has('score') &&
    normalized.has('lead_name');
  if (hasNew) {
    return 'NEW';
  }

  const hasOldApplywizz =
    normalized.has('applywizz_id') ||
    headerKeys.some((k) => normalizeHeaderKey(k) === 'applywizz_id');
  const hasOldClient =
    normalized.has('client_name') ||
    headerKeys.some((k) => normalizeHeaderKey(k) === 'client_name');
  const hasOldUrl =
    normalized.has('url') ||
    normalized.has('company_job_url') ||
    normalized.has('job_url');
  const hasOldScore = normalized.has('score');
  const hasClientLabel =
    hasOldClient || normalized.has('lead_name');

  if (hasOldApplywizz && hasClientLabel && hasOldUrl && hasOldScore) {
    return 'OLD';
  }

  return 'UNKNOWN';
}

function getColumnValue(row: Record<string, string>, ...aliases: string[]): string {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== null) {
      return String(row[alias]).trim();
    }
    const matchKey = Object.keys(row).find((k) => normalizeHeaderKey(k) === normalizeHeaderKey(alias));
    if (matchKey && row[matchKey] !== undefined && row[matchKey] !== null) {
      return String(row[matchKey]).trim();
    }
  }
  return '';
}

function extractUrlFromCompanyJobUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0].replace(/[),.;]+$/, '') : trimmed;
}

function parseScore(rawScore: string | number | undefined): number {
  if (rawScore === undefined || rawScore === null || rawScore === '') {
    return 0;
  }
  const numScore = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore).trim());
  return Number.isNaN(numScore) ? 0 : numScore;
}

/**
 * Maps a CSV data row to unified job fields for OLD or NEW format.
 */
export function parseCsvJobRow(
  row: Record<string, string>,
  format: CsvIngestFormat
): ParsedCsvJobRow | null {
  if (format === 'UNKNOWN') {
    return null;
  }

  if (format === 'NEW') {
    const companyJobUrl = getColumnValue(row, 'company_job_url');
    const rawUrl = extractUrlFromCompanyJobUrl(companyJobUrl);
    const applywizzId = getColumnValue(row, 'applywizz_id', 'Applywizz ID').toUpperCase();
    const clientName = getColumnValue(row, 'lead_name', 'client_name', 'Client Name');
    const score = parseScore(getColumnValue(row, 'score', 'Score') || undefined);
    const date = getColumnValue(row, 'date', 'Date');
    const scoredJobId = getColumnValue(row, 'scored_jobId', 'scored_job_id');
    const status = getColumnValue(row, 'status', 'Status') || 'PENDING';

    if (!applywizzId || !rawUrl) {
      return null;
    }

    return {
      applywizzId,
      clientName: clientName || applywizzId,
      rawUrl,
      date,
      score,
      scoredJobId,
      status,
    };
  }

  const applywizzId = getColumnValue(row, 'Applywizz ID', 'applywizz_id', 'ApplywizzID').toUpperCase();
  const clientName = getColumnValue(
    row,
    'Client Name',
    'client_name',
    'ClientName',
    'lead_name',
    'Lead Name'
  );
  let rawUrl = getColumnValue(row, 'url', 'URL', 'job_url', 'Job URL');
  if (!rawUrl) {
    rawUrl = extractUrlFromCompanyJobUrl(getColumnValue(row, 'company_job_url', 'Company Job URL'));
  }
  const date = getColumnValue(row, 'Date', 'date');
  const score = parseScore(getColumnValue(row, 'score', 'Score') || undefined);
  const scoredJobId = getColumnValue(row, 'scored_jobId', 'scored_job_id');
  const status = getColumnValue(row, 'status', 'Status') || 'PENDING';

  if (!applywizzId || !rawUrl) {
    return null;
  }

  return {
    applywizzId,
    clientName: clientName || applywizzId,
    rawUrl,
    date,
    score,
    scoredJobId,
    status,
  };
}

/**
 * Options configuring candidate segregation and profile synchronization.
 */
export interface SegregatorOptions {
  /**
   * Maximum number of candidate rows to process from CSV.
   * @default undefined (processes all rows)
   */
  limit?: number;

  /**
   * Maximum number of jobs per candidate.
   * @default undefined (processes all candidate jobs)
   */
  maxJobsPerCandidate?: number;

  /**
   * Maximum simultaneous HTTP requests when syncing candidate profiles.
   * @default 10
   */
  concurrency?: number;

  /**
   * Optional candidate identifier to specifically filter for (e.g. 'AWL-31428').
   */
  candidateId?: string;

  /**
   * Whether to fetch candidate profiles from ApplyWizz API or cache.
   * @default true
   */
  syncProfiles?: boolean;

  /**
   * Whether to download master PDF resumes into ./resumes/.
   * @default true
   */
  downloadResumes?: boolean;

  /**
   * Whether outbound ApplyWizz API calls are permitted when profile is not in Supabase/cache.
   * STRICT: defaults to false per Rule 1.
   * @default false
   */
  allowOutboundApi?: boolean;

  /**
   * Optional custom ApplyWizzClient instance.
   */
  client?: ApplyWizzClient;

  /**
   * Progress update callback.
   */
  onProgress?: (stats: { processedCandidates: number; totalCandidates: number; totalJobs: number }) => void;

  /**
   * When true with syncProfiles=false: upsert candidate_applications from CSV without requiring profile/Zoho sync.
   */
  applicationRowsFromCsvOnly?: boolean;
}

/**
 * Stream-parses the input CSV, groups job postings by unique `Applywizz ID`,
 * queries candidate profiles from ApplyWizz API with retry logic, downloads resumes,
 * and returns a map of candidate segments.
 *
 * @param csvPath - Path to the input CSV file.
 * @param options - Configuration options for segregation and syncing.
 * @returns Promise resolving to a Map of applywizzId -> CandidateSegment.
 *
 * @throws Error if the CSV file does not exist.
 */
export async function segregateCandidatesByApplyWizzId(
  csvPath: string = config.INPUT_CSV_PATH,
  options: SegregatorOptions = {}
): Promise<Map<string, CandidateSegment>> {
  const {
    limit,
    maxJobsPerCandidate,
    concurrency = 10,
    syncProfiles = true,
    downloadResumes = true,
    allowOutboundApi = false,
    client = new ApplyWizzClient(),
    candidateId,
    onProgress,
    applicationRowsFromCsvOnly = false,
  } = options;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`Input CSV file not found at: "${csvPath}"`);
  }

  const compact = isPipelineCompactLogging();

  const segmentsMap = new Map<string, CandidateSegment>();
  let rowCount = 0;
  let csvFormat: CsvIngestFormat | null = null;
  let formatLogged = false;
  let skippedUnknownFormatRows = 0;
  let skippedInvalidRows = 0;
  let droppedScoreRows = 0;

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(csvPath);

    fastCsv
      .parseStream(stream, { headers: true, trim: true, ignoreEmpty: true })
      .on('error', (err) => {
        haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed', err);
      })
      .on('data', (row: Record<string, string>) => {
        rowCount++;

        if (csvFormat === null) {
          csvFormat = detectCsvFormat(Object.keys(row));
          if (!formatLogged) {
            if (!compact) {
              log.info(
                `[Segregator] Format detected: ${csvFormat === 'UNKNOWN' ? 'UNKNOWN' : csvFormat}`
              );
            }
            formatLogged = true;
          }
        }

        if (csvFormat === 'UNKNOWN') {
          skippedUnknownFormatRows++;
          if (skippedUnknownFormatRows === 1) {
            log.error(
              '[Segregator] Unknown CSV format — expected OLD (Applywizz ID, Client Name, url, score) or NEW (company_job_url, applywizz_id, score, lead_name). Skipping rows.'
            );
          }
          return;
        }

        const parsed = parseCsvJobRow(row, csvFormat);
        if (!parsed) {
          skippedInvalidRows++;
          if (skippedInvalidRows === 1) {
            log.warn(
              `[Segregator] Invalid row for detected format (${csvFormat}) — skipping; summary logged after CSV ingest completes.`
            );
          }
          return;
        }

        const { applywizzId, clientName, rawUrl, date, score, scoredJobId, status } = parsed;

        if (score < 20 || score > 60) {
          droppedScoreRows++;
          if (!compact && droppedScoreRows === 1) {
            log.info(
              `[Segregator] Dropping jobs outside dashboard score range 20–60 (summary after ingest).`
            );
          }
          return;
        }

        if (candidateId && applywizzId.toUpperCase() !== candidateId.toUpperCase()) {
          return;
        }

        const canonicalUrl = normalizeGreenhouseUrl(rawUrl);

        if (!segmentsMap.has(applywizzId)) {
          if (limit && segmentsMap.size >= limit) {
            return;
          }
          segmentsMap.set(applywizzId, {
            applywizzId,
            clientName: clientName || applywizzId,
            jobs: [],
            totalJobs: 0,
            syncedAt: new Date().toISOString(),
          });
        }

        const segment = segmentsMap.get(applywizzId)!;

        if (!segment.jobs.some((j) => j.canonicalUrl === canonicalUrl)) {
          if (!maxJobsPerCandidate || segment.jobs.length < maxJobsPerCandidate) {
            segment.jobs.push({
              rawUrl,
              canonicalUrl,
              date,
              score,
              scoredJobId,
              status,
            });
            segment.totalJobs = segment.jobs.length;
          }
        }
      })
      .on('end', () => resolve());
  });

  if (rowCount === 0 || csvFormat === 'UNKNOWN') {
    haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed');
  }
  if (
    segmentsMap.size === 0 &&
    skippedInvalidRows > 0 &&
    droppedScoreRows === 0 &&
    !candidateId
  ) {
    haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed');
  }

  if (compact) {
    log.info(
      `[Candidate Segregator] csv ingest rows=${rowCount.toLocaleString()} candidates=${segmentsMap.size.toLocaleString()} format=${csvFormat ?? 'UNKNOWN'} skipped_invalid=${skippedInvalidRows} dropped_score=${droppedScoreRows} skipped_unknown_format=${skippedUnknownFormatRows}`
    );
  } else {
    if (skippedUnknownFormatRows > 0) {
      log.warn(
        `[Segregator] Skipped ${skippedUnknownFormatRows.toLocaleString()} row(s): unknown CSV format.`
      );
    }
    if (skippedInvalidRows > 0) {
      log.warn(
        `[Segregator] Skipped ${skippedInvalidRows.toLocaleString()} row(s): missing applywizz id or job URL for format ${csvFormat ?? 'UNKNOWN'}.`
      );
    }
    if (droppedScoreRows > 0) {
      log.info(
        `[Segregator] Dropped ${droppedScoreRows.toLocaleString()} row(s) with score outside 20–60.`
      );
    }
    log.info(
      `[Candidate Segregator] 📊 Ingested ${rowCount.toLocaleString()} rows. Segregated ${segmentsMap.size.toLocaleString()} unique candidates.`
    );
  }

  // Synchronize Candidate Profiles & Resumes
  if (syncProfiles && segmentsMap.size > 0) {
    const candidateIds = Array.from(segmentsMap.keys());
    const totalCandidates = candidateIds.length;
    if (!compact) {
      log.info(
        `[Candidate Segregator] 🔄 Syncing ${totalCandidates.toLocaleString()} candidate profiles (Supabase-first, API only for new candidates) (Concurrency: ${concurrency})...`
      );
    }

    let completed = 0;
    let fromSupabase = 0;
    let fromApi = 0;
    let skippedEnsured = 0;
    let skippedNotZoho = 0;
    let skippedSyncFailed = 0;
    const queue = [...candidateIds];
    const workers: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        throwIfPipelineAborted('Candidate profile sync');
        const id = queue.shift();
        if (!id) break;

        const segment = segmentsMap.get(id);
        if (!segment) continue;

        try {
          const ensured = await ensureSupabaseProfile(id, {
            allowOutboundApi,
            downloadResumes,
            client,
          });

          if (ensured.status === 'skipped' || ensured.status === 'failed' || !ensured.profile) {
            segmentsMap.delete(id);
            skippedEnsured++;
            if (!compact) {
              log.info(
                `[Segregator] ⛔ Skipping candidate ${id} (${ensured.reason || ensured.status})`
              );
            }
            continue;
          }

          if (ensured.status === 'created') fromApi++;
          else fromSupabase++;

          if (!ensured.profile.zoho_connected) {
            segmentsMap.delete(id);
            skippedNotZoho++;
            if (!compact) {
              log.info(
                `[Segregator] ⛔ Skipping candidate ${id} (not Zoho connected)` +
                  (ensured.status === 'created' ? ' — profiles row was created' : '')
              );
            }
            continue;
          }

          segment.profile = profileRowToCandidateProfile(ensured.profile);
          if (ensured.profile.client_name && ensured.profile.client_name !== id) {
            segment.clientName = ensured.profile.client_name;
          }
        } catch (err: any) {
          skippedSyncFailed++;
          if (!compact) {
            log.warn(`[Candidate Segregator] ⚠️ Failed to sync candidate ${id}: ${err.message}. Skipping profile sync.`);
          }
        } finally {
          completed++;
          if (onProgress) {
            onProgress({
              processedCandidates: completed,
              totalCandidates,
              totalJobs: segment.totalJobs,
            });
          }
        }
      }
    };

    const poolSize = Math.min(concurrency, totalCandidates);
    for (let i = 0; i < poolSize; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    if (compact) {
      log.info(
        `[Candidate Segregator] profile sync candidates=${totalCandidates} kept=${segmentsMap.size} supabase=${fromSupabase} api_new=${fromApi} skipped_ensure=${skippedEnsured} skipped_not_zoho=${skippedNotZoho} sync_failed=${skippedSyncFailed}`
      );
    } else {
      log.info(
        `[Candidate Segregator] ✅ Profile sync complete: ${fromSupabase} from Supabase (0 API calls), ${fromApi} new via API (${completed}/${totalCandidates} total).`
      );
    }
  }

  // Remove candidates that could not be loaded from Supabase/cache or were not Zoho-connected.
  let skippedNoProfile = 0;
  if (syncProfiles && !applicationRowsFromCsvOnly) {
    for (const [id, segment] of Array.from(segmentsMap.entries())) {
      if (!segment.profile) {
        segmentsMap.delete(id);
        skippedNoProfile++;
        if (!compact) {
          log.info(`[Segregator] ⛔ Skipping candidate ${id} (profile unavailable or not Zoho connected)`);
        }
      }
    }
    if (compact && skippedNoProfile > 0) {
      log.info(`[Candidate Segregator] profile filter removed=${skippedNoProfile} (no profile after sync)`);
    }
  }

  let applicationJobsAttempted = 0;
  let applicationRowsUpserted = 0;
  let applicationSkippedOverCap = 0;
  let applicationSkippedNoProfile = 0;
  let applicationUpsertFailed = 0;
  for (const segment of segmentsMap.values()) {
    const rowResult = await ensureApplicationRowsForSegment(segment);
    applicationJobsAttempted += rowResult.attempted;
    applicationRowsUpserted += rowResult.upserted;
    applicationSkippedOverCap += rowResult.skippedOverCap;
    applicationSkippedNoProfile += rowResult.skippedNoProfile;
    applicationUpsertFailed += rowResult.failed;
  }
  if (applicationJobsAttempted > 0) {
    log.info(
      `[Candidate Segregator] candidate_applications attempted=${applicationJobsAttempted} upserted=${applicationRowsUpserted} skipped_over_cap=${applicationSkippedOverCap} skipped_no_profile=${applicationSkippedNoProfile} failed=${applicationUpsertFailed}`
    );
  }

  return segmentsMap;
}

/**
 * Upserts candidate_applications for every CSV (applywizz_id, job_url) without profile sync.
 * Call after scan so scanned_job_templates metadata is available for enrichment.
 */
export async function ensureApplicationRowsFromCsv(
  csvPath: string,
  options: Pick<SegregatorOptions, 'limit' | 'maxJobsPerCandidate' | 'candidateId'> = {}
): Promise<Map<string, CandidateSegment>> {
  return segregateCandidatesByApplyWizzId(csvPath, {
    ...options,
    syncProfiles: false,
    downloadResumes: false,
    applicationRowsFromCsvOnly: true,
  });
}

/**
 * Serializes the segregated candidate mapping to `output/candidate_segments.json`.
 *
 * @param segments - Map of applywizzId -> CandidateSegment.
 * @param outputDir - Destination directory (defaults to `config.OUTPUT_DIR` or `./output`).
 * @returns Promise resolving to the absolute output file path.
 */
export async function exportCandidateSegments(
  segments: Map<string, CandidateSegment>,
  outputDir: string = config.OUTPUT_DIR
): Promise<string> {
  const resolvedDir = path.resolve(process.cwd(), outputDir);

  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const jsonPath = path.join(resolvedDir, 'candidate_segments.json');
  const serialized = JSON.stringify(Array.from(segments.values()), null, 2);

  await fs.promises.writeFile(jsonPath, serialized, 'utf-8');
  const stats = fs.statSync(jsonPath);

  if (isPipelineCompactLogging()) {
    log.info(
      `[Candidate Segregator] export segments=${segments.size.toLocaleString()} path=${jsonPath} kb=${(stats.size / 1024).toFixed(1)}`
    );
  } else {
    log.info(
      `[Candidate Segregator] 💾 Exported ${segments.size.toLocaleString()} candidate segments to: ${jsonPath} (${(stats.size / 1024).toFixed(1)} KB)`
    );
  }

  return jsonPath;
}
