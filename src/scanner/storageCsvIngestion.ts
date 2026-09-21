/**
 * @fileoverview Automated Ingestion Service for CSV Dropzone in Supabase Storage.
 *
 * Workflow:
 * 1. Checks `csv_uploads` bucket in Supabase Storage for newly uploaded CSV files.
 * 2. Downloads the pending CSV to a temporary local file.
 * 3. Runs the master V1Pipeline with single worker concurrency for Railway survival.
 * 4. CSV applywizz IDs are the approval to fetch missing ApplyWizz profiles (then persist to `profiles`).
 * 5. Moves processed CSV into `csv_uploads/archive/` to prevent re-processing.
 * 6. Cleans up temporary files.
 *
 * Can be run programmatically via Express route `POST /api/admin/trigger-ingest-from-storage`
 * or via CLI: `npm run ingest:storage`.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getDbClient, isSupabaseConfigured, resolveSupabaseCredentials, listSupabaseKeyCandidates, createSupabaseServerClient, replaceDbClient } from '../db/client.js';
import { getSupabaseKeyDiagnostics } from '../db/supabaseKeyDiagnostics.js';
import { CSV_UPLOADS_BUCKET } from '../db/storage.js';
import { V1Pipeline, PipelineResult } from '../orchestrator/pipeline.js';
import { config } from '../config/env.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import {
  isPipelineAbortedError,
  isPipelineStopEnabled,
  requestPipelineAbort,
  resetPipelineAbort,
} from '../orchestrator/pipelineAbort.js';
import crypto from 'crypto';
import { upsertIngestRun } from '../db/ingestRuns.js';

const log = createLogger('Storage Csv Ingestion');

export interface StorageIngestionResult {
  success: boolean;
  processedCount: number;
  processedFile?: string;
  archivePath?: string;
  pipelineResult?: PipelineResult;
  message: string;
  /** Set when an operator stopped the run via dev stop control */
  aborted?: boolean;
}

type DropzoneCsv = { name: string; createdAt: string | null };

function isPendingCsvObjectName(name: string): boolean {
  const n = (name || '').replace(/^\/+/, '').trim();
  if (!n || n.startsWith('.')) return false;
  const lower = n.toLowerCase();
  if (!lower.endsWith('.csv')) return false;
  if (lower === 'archive' || lower.startsWith('archive/')) return false;
  return true;
}

/**
 * Probe every configured key with a fresh client. Anon/publishable JWTs return [] with no error.
 */
export async function listPendingDropzoneCsvs(): Promise<{
  files: DropzoneCsv[];
  source: string;
  listedNames: string[];
  probeLines: string[];
}> {
  const { url, candidates } = listSupabaseKeyCandidates();
  const probeLines: string[] = [];

  if (candidates.length === 0) {
    probeLines.push('no SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY on this process');
    return { files: [], source: 'storage.list', listedNames: [], probeLines };
  }

  for (const candidate of candidates) {
    const diag = getSupabaseKeyDiagnostics(url, candidate.key);
    const client = createSupabaseServerClient(url, candidate.key);
    const { data: listed, error: listError } = await client.storage
      .from(CSV_UPLOADS_BUCKET)
      .list('', { limit: 100, offset: 0 });
    const listNames = (listed || []).map((f) => f.name).filter(Boolean);
    const line = `${candidate.source}: jwt.role=${diag.jwtRole ?? 'unknown'} keyShape=${diag.keyShape} urlRefMatch=${diag.urlRefMatch} entries=${listNames.length} names=${listNames.join(',') || '(none)'}${listError ? ` error=${listError.message}` : ''}`;
    probeLines.push(line);
    if (!isPipelineCompactLogging()) {
      log.info(`[Storage CSV Ingestion] Probe ${line}`);
    }

    const fromList = (listed || [])
      .filter((f) => isPendingCsvObjectName(f.name || ''))
      .map((f) => ({ name: f.name, createdAt: f.created_at ?? null }));
    if (fromList.length > 0) {
      fromList.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      replaceDbClient(client);
      return { files: fromList, source: candidate.source, listedNames: listNames, probeLines };
    }
  }

  return {
    files: [],
    source: 'storage.list',
    listedNames: [],
    probeLines,
  };
}

/**
 * Checks the `csv_uploads` storage bucket, ingests the latest CSV file, and moves it to `archive/`.
 */
export async function ingestCsvFromStorage(options?: {
  runId?: string;
  triggeredBy?: string;
}): Promise<StorageIngestionResult> {
  const runId = options?.runId || crypto.randomUUID();
  const triggeredBy = options?.triggeredBy;

  if (!isSupabaseConfigured()) {
    haltWithDevAlert(
      'Supabase',
      'Supabase connection failure — bad credentials, unreachable, or empty key probe'
    );
  }

  const { url: supabaseUrl, serviceKey: rawServiceKey, serviceKeySource } = resolveSupabaseCredentials();
  const keyDiag = getSupabaseKeyDiagnostics(supabaseUrl, rawServiceKey);
  const compact = isPipelineCompactLogging();
  if (!compact) {
    log.info(
      `[Storage CSV Ingestion] Credential identity (${serviceKeySource ?? 'unknown'}): ${keyDiag.summary}`
    );
  }
  if (keyDiag.keyHadSurroundingWhitespace) {
    log.warn(
      '[Storage CSV Ingestion] SUPABASE_SERVICE_KEY has leading/trailing whitespace — trim the value in Railway.'
    );
  }

  if (!compact) {
    log.info(`[Storage CSV Ingestion] 🔍 Checking bucket '${CSV_UPLOADS_BUCKET}' for pending CSV files...`);
  }

  const { files: pendingCsvFiles, source, probeLines } = await listPendingDropzoneCsvs();

  if (pendingCsvFiles.length === 0) {
    const probe = probeLines.join(' | ') || '(no keys probed)';
    const hint = ` Source=${source}. ${probe}`;
    const { candidates } = listSupabaseKeyCandidates();
    const looksLikeEmptyKeyProbe =
      candidates.length === 0 ||
      probeLines.every((line) => !/jwt\.role=service_role/.test(line));
    if (looksLikeEmptyKeyProbe) {
      haltWithDevAlert(
        'Supabase',
        'Supabase connection failure — bad credentials, unreachable, or empty key probe'
      );
    }
    log.info(`[Storage CSV Ingestion] ℹ️ No pending CSV files found in dropzone.${hint}`);
    void upsertIngestRun({
      id: runId,
      status: 'completed',
      finished_at: new Date().toISOString(),
      processed_count: 0,
      phase: 'Completed',
      message: `No pending CSV files in csv_uploads storage dropzone.${hint}`,
      triggered_by: triggeredBy,
    });
    return {
      success: false,
      processedCount: 0,
      message: `No pending CSV files in csv_uploads storage dropzone.${hint}`,
    };
  }

  const supabase = getDbClient();
  const targetFile = pendingCsvFiles[0];
  log.info(
    `[Storage CSV Ingestion] ingest file="${targetFile.name}" source=${source} bucket=${CSV_UPLOADS_BUCKET}`
  );

  void upsertIngestRun({
    id: runId,
    status: 'running',
    processed_file: targetFile.name,
    phase: 'Phase A',
    message: `Starting ingestion for ${targetFile.name}`,
    triggered_by: triggeredBy,
  });

  // Download from Supabase Storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(CSV_UPLOADS_BUCKET)
    .download(targetFile.name);

  if (downloadError || !fileData) {
    log.error(`[Storage CSV Ingestion] ❌ Download failed:`, downloadError?.message);
    const errMessage = `Failed to download ${targetFile.name}: ${downloadError?.message}`;
    void upsertIngestRun({
      id: runId,
      status: 'failed',
      finished_at: new Date().toISOString(),
      processed_file: targetFile.name,
      phase: 'Failed',
      error: errMessage,
      message: errMessage,
      triggered_by: triggeredBy,
    });
    throw new Error(errMessage);
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Write to temporary local file
  const sanitizedName = path.basename(targetFile.name).replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempFilePath = path.join(os.tmpdir(), `csv_dropzone_${Date.now()}_${sanitizedName}`);
  fs.writeFileSync(tempFilePath, buffer);
  if (!compact) {
    log.info(`[Storage CSV Ingestion] 💾 Saved temp CSV to: ${tempFilePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  }

  let pipelineResult: PipelineResult | undefined;
  let currentPhase = 'Phase A';
  const originalConsoleLog = console.log;

  try {
    resetPipelineAbort();
    // Run V1Pipeline with single worker concurrency for Railway stability
    const pipeline = new V1Pipeline();
    log.info(`[Storage CSV Ingestion] pipeline start file="${targetFile.name}" workers=${config.WORKER_POOL_SIZE || 1}`);

    console.log = (...args: unknown[]) => {
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
        const match = text.match(/(?:\[Pipeline Phase |\[Pipeline\] phase )([A-D](?:\.5)?)/i);
        if (match) {
          const phaseLetter = match[1].toUpperCase();
          const phaseName = `Phase ${phaseLetter}`;
          if (phaseName !== currentPhase) {
            currentPhase = phaseName;
            void upsertIngestRun({
              id: runId,
              status: 'running',
              processed_file: targetFile.name,
              phase: phaseName,
              message: `Executing ${phaseName}`,
              triggered_by: triggeredBy,
            });
          }
        }
      } catch {
        // Safe fallback if formatting fails
      }
      return originalConsoleLog.apply(console, args);
    };

    try {
      pipelineResult = await pipeline.runFullPipeline(tempFilePath, config.OUTPUT_DIR, {
        concurrency: config.WORKER_POOL_SIZE || 1,
      });
    } catch (pipelineErr) {
      if (isPipelineAbortedError(pipelineErr)) {
        log.warn(`[Storage CSV Ingestion] ⏹️ ${pipelineErr.message}`);
        void upsertIngestRun({
          id: runId,
          status: 'aborted',
          finished_at: new Date().toISOString(),
          processed_count: 0,
          processed_file: targetFile.name,
          phase: 'Aborted',
          message: pipelineErr.message,
          triggered_by: triggeredBy,
        });
        return {
          success: false,
          processedCount: 0,
          processedFile: targetFile.name,
          message: pipelineErr.message,
          aborted: true,
        };
      }
      const errMessage = (pipelineErr as any)?.message || String(pipelineErr);
      void upsertIngestRun({
        id: runId,
        status: 'failed',
        finished_at: new Date().toISOString(),
        processed_count: 0,
        processed_file: targetFile.name,
        phase: 'Failed',
        error: errMessage,
        message: errMessage,
        triggered_by: triggeredBy,
      });
      throw pipelineErr;
    }

    const pr = pipelineResult;
    log.info(
      `[Storage CSV Ingestion] pipeline complete file="${targetFile.name}" candidates=${pr?.uniqueCandidates ?? '?'} urls=${pr?.uniqueUrls ?? '?'} applications=${pr?.resolvedApplications ?? '?'} duration_ms=${pr?.durationMs ?? '?'} status=${pr?.status ?? '?'}`
    );

    // Move processed CSV to archive folder in Supabase Storage
    const archiveDest = `archive/${Date.now()}_${sanitizedName}`;
    const { error: moveError } = await supabase.storage
      .from(CSV_UPLOADS_BUCKET)
      .move(targetFile.name, archiveDest);

    if (moveError) {
      log.warn(`[Storage CSV Ingestion] ⚠️ Warning: Could not move file to ${archiveDest}: ${moveError.message}`);
    } else {
      if (!compact) log.info(`[Storage CSV Ingestion] 📦 Archived storage file to: ${archiveDest}`);
    }

    void upsertIngestRun({
      id: runId,
      status: 'completed',
      finished_at: new Date().toISOString(),
      processed_count: 1,
      processed_file: targetFile.name,
      phase: 'Completed',
      message: `Successfully processed and archived ${targetFile.name}.`,
      triggered_by: triggeredBy,
    });

    return {
      success: true,
      processedCount: 1,
      processedFile: targetFile.name,
      archivePath: archiveDest,
      pipelineResult,
      message: `Successfully processed and archived ${targetFile.name}.`,
    };
  } finally {
    console.log = originalConsoleLog;
    // Clean up temporary local file
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        if (!compact) log.info(`[Storage CSV Ingestion] 🧹 Cleaned up temp file: ${tempFilePath}`);
      }
    } catch (cleanupErr: any) {
      log.warn(`[Storage CSV Ingestion] ⚠️ Could not remove temp file: ${cleanupErr.message}`);
    }
  }
}

// Direct CLI execution check
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  log.info('--- Starting Storage CSV Ingestion CLI ---');
  if (isPipelineStopEnabled()) {
    process.on('SIGINT', () => {
      log.warn('[Storage CSV Ingestion] ⏹️ SIGINT — requesting pipeline stop…');
      requestPipelineAbort();
    });
  }
  ingestCsvFromStorage()
    .then((result) => {
      log.info('Result:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      haltWithDevAlert('CSV', 'CSV parse failure — malformed CSV or zero valid rows parsed', err);
    });
}
