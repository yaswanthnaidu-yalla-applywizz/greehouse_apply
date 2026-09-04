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
import type { CandidateSegment } from '../types/index.js';

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
   * Maximum simultaneous HTTP requests when syncing candidate profiles.
   * @default 10
   */
  concurrency?: number;

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
   * Optional custom ApplyWizzClient instance.
   */
  client?: ApplyWizzClient;

  /**
   * Progress update callback.
   */
  onProgress?: (stats: { processedCandidates: number; totalCandidates: number; totalJobs: number }) => void;
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
    concurrency = 10,
    syncProfiles = true,
    downloadResumes = true,
    client = new ApplyWizzClient(),
    onProgress,
  } = options;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`Input CSV file not found at: "${csvPath}"`);
  }

  console.log(`[Candidate Segregator] 📂 Ingesting candidate rows from: ${csvPath}`);

  const segmentsMap = new Map<string, CandidateSegment>();
  let rowCount = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(csvPath);

    fastCsv
      .parseStream(stream, { headers: true, trim: true, ignoreEmpty: true })
      .on('error', (err) => reject(new Error(`Failed to parse CSV: ${err.message}`)))
      .on('data', (row: Record<string, string>) => {
        rowCount++;

        const applywizzId = (row['Applywizz ID'] || row['applywizz_id'] || row['ApplywizzID'] || '').trim();
        const clientName = (row['Client Name'] || row['client_name'] || row['ClientName'] || '').trim();
        const rawUrl = (row.url || row.URL || row.job_url || '').trim();
        const date = row.Date || row.date || '';
        const score = row.score || 0;
        const scoredJobId = row.scored_jobId || row.scored_job_id || '';
        const status = row.status || 'PENDING';

        if (!applywizzId || !rawUrl) {
          return;
        }

        const canonicalUrl = normalizeGreenhouseUrl(rawUrl);

        if (!segmentsMap.has(applywizzId)) {
          segmentsMap.set(applywizzId, {
            applywizzId,
            clientName: clientName || applywizzId,
            jobs: [],
            totalJobs: 0,
            syncedAt: new Date().toISOString(),
          });
        }

        const segment = segmentsMap.get(applywizzId)!;

        // Add job if not duplicate for this candidate
        if (!segment.jobs.some((j) => j.canonicalUrl === canonicalUrl)) {
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

        if (limit && segmentsMap.size >= limit) {
          stream.destroy();
          resolve();
        }
      })
      .on('end', () => resolve());
  });

  console.log(
    `[Candidate Segregator] 📊 Ingested ${rowCount.toLocaleString()} rows. Segregated ${segmentsMap.size.toLocaleString()} unique candidates.`
  );

  // Synchronize Candidate Profiles & Resumes
  if (syncProfiles && segmentsMap.size > 0) {
    const candidateIds = Array.from(segmentsMap.keys());
    const totalCandidates = candidateIds.length;
    console.log(
      `[Candidate Segregator] 🔄 Syncing ${totalCandidates.toLocaleString()} candidate profiles via ApplyWizz API (Concurrency: ${concurrency})...`
    );

    let completed = 0;
    const queue = [...candidateIds];
    const workers: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;

        const segment = segmentsMap.get(id);
        if (!segment) continue;

        try {
          const profile = await client.fetchCandidateProfile(id);
          segment.profile = profile;

          // If clientName in CSV was fallback, update with full name from API
          if (profile.clientName && profile.clientName !== id) {
            segment.clientName = profile.clientName;
          }

          if (downloadResumes && profile.resumeUrl) {
            await client.downloadResume(id, profile.resumeUrl);
          }
        } catch (err: any) {
          console.warn(`[Candidate Segregator] ⚠️ Failed to sync candidate ${id}: ${err.message}. Skipping profile sync.`);
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
    console.log(`[Candidate Segregator] ✅ Profile synchronization complete for ${completed}/${totalCandidates} candidates.`);
  }

  return segmentsMap;
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

  console.log(
    `[Candidate Segregator] 💾 Exported ${segments.size.toLocaleString()} candidate segments to: ${jsonPath} (${(stats.size / 1024).toFixed(1)} KB)`
  );

  return jsonPath;
}
