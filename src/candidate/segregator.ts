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
import { profileRowToCandidateProfile, upsertProfile, getProfile, updateResumeStoragePath } from '../db/profiles.js';
import { uploadResume } from '../db/storage.js';
import { isZohoConnected } from '../services/zohoConnectedAllowlist.js';
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
        const rawScore = row.score !== undefined ? row.score : (row.Score !== undefined ? row.Score : 0);
        const numScore = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore).trim());
        const score = isNaN(numScore) ? 0 : numScore;
        const scoredJobId = row.scored_jobId || row.scored_job_id || '';
        const status = row.status || 'PENDING';

        if (!applywizzId || !rawUrl) {
          return;
        }

        // Score filter: Discard rows with score < 20 || score > 60
        if (score < 20 || score > 60) {
          console.log(
            `[Candidate Segregator] ⏭️ Discarding row for candidate ${applywizzId} (job: ${rawUrl}) — score ${score} out of range [20, 60].`
          );
          return;
        }

        if (candidateId && applywizzId.toUpperCase() !== candidateId.toUpperCase()) {
          return;
        }

        const canonicalUrl = normalizeGreenhouseUrl(rawUrl);

        if (!segmentsMap.has(applywizzId)) {
          if (limit && segmentsMap.size >= limit) {
            return; // Skip candidates beyond the limit
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

        // Add job if not duplicate for this candidate and below maxJobs limit
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

  console.log(
    `[Candidate Segregator] 📊 Ingested ${rowCount.toLocaleString()} rows. Segregated ${segmentsMap.size.toLocaleString()} unique candidates.`
  );

  // Synchronize Candidate Profiles & Resumes
  if (syncProfiles && segmentsMap.size > 0) {
    const candidateIds = Array.from(segmentsMap.keys());
    const totalCandidates = candidateIds.length;
    console.log(
      `[Candidate Segregator] 🔄 Syncing ${totalCandidates.toLocaleString()} candidate profiles (Supabase-first, API only for new candidates) (Concurrency: ${concurrency})...`
    );

    let completed = 0;
    let fromSupabase = 0;
    let fromApi = 0;
    const queue = [...candidateIds];
    const workers: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;

        const segment = segmentsMap.get(id);
        if (!segment) continue;

        try {
          // Check Supabase first — zero network requests for existing candidates
          const existingProfile = await getProfile(id);
          if (existingProfile) {
            segment.profile = profileRowToCandidateProfile(existingProfile);
            if (existingProfile.client_name && existingProfile.client_name !== id) {
              segment.clientName = existingProfile.client_name;
            }
            fromSupabase++;
          } else {
            const isCached = client.isProfileCached(id);
            if (!isCached && !allowOutboundApi) {
              console.log(
                `[Candidate Ingestion] ⚠️ Candidate ${id} not found in Supabase or local cache. Skipping unapproved outbound API request per Rule 1.`
              );
              continue;
            }

            // ONLY for candidates in local cache or allowed
            console.log(
              `[Candidate Ingestion] ℹ️ Candidate ${id} profile lookup (checking cache first)...`
            );
            const { profile, raw } = await client.fetchCandidateProfileWithRaw(id, false);
            segment.profile = profile;

            if (profile.clientName && profile.clientName !== id) {
              segment.clientName = profile.clientName;
            }

            let resumeStoragePath: string | null = null;
            if (downloadResumes && profile.resumeUrl) {
              const localPath = await client.downloadResume(id, profile.resumeUrl);
              try {
                if (fs.existsSync(localPath) && fs.statSync(localPath).size > 100) {
                  const buffer = await fs.promises.readFile(localPath);
                  resumeStoragePath = await uploadResume(id, buffer);
                }
              } catch (uploadErr: any) {
                console.warn(
                  `[Candidate Ingestion] ⚠️ Could not upload resume for ${id} to Supabase Storage: ${uploadErr.message}`
                );
              }
            }

            try {
              await upsertProfile({
                applywizz_id: profile.applywizzId,
                client_name: profile.clientName || id,
                first_name: profile.firstName || null,
                last_name: profile.lastName || null,
                company_email: profile.email || null,
                email: profile.email || null,
                phone: profile.phone || null,
                country: profile.country || null,
                country_code: profile.countryCode || null,
                location: profile.location || null,
                linkedin_url: profile.linkedinUrl || null,
                website_url: profile.websiteUrl || null,
                github_url: profile.githubUrl || null,
                work_authorization: profile.workAuthorization || null,
                requires_sponsorship: Boolean(profile.requiresSponsorship),
                education: profile.education || [],
                work_experience: profile.workExperience || [],
                resume_url: profile.resumeUrl || null,
                resume_storage_path: resumeStoragePath,
                raw_api_payload: {
                  ...raw,
                  demographics: profile.demographics || raw.demographics,
                },
                last_api_fetch_at: new Date().toISOString(),
              });
              if (resumeStoragePath) {
                await updateResumeStoragePath(id, resumeStoragePath);
              }
            } catch (dbErr: any) {
              console.warn(
                `[Candidate Ingestion] ⚠️ Could not upsert new candidate profile ${id} to Supabase: ${dbErr.message}`
              );
            }
            fromApi++;
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
    console.log(
      `[Candidate Segregator] ✅ Profile sync complete: ${fromSupabase} from Supabase (0 API calls), ${fromApi} new via API (${completed}/${totalCandidates} total).`
    );
  }

  // Zoho gate: Verify candidate's company email is in Zoho allowlist
  for (const [id, segment] of Array.from(segmentsMap.entries())) {
    const companyEmail = segment.profile?.email || null;
    if (!isZohoConnected(companyEmail)) {
      segmentsMap.delete(id);
      console.log(`[Candidate Segregator] ⛔ Skipping ${id} — not in Zoho allowlist.`);
    }
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
