/**
 * @fileoverview Automated Ingestion Service for CSV Dropzone in Supabase Storage.
 *
 * Workflow:
 * 1. Checks `csv_uploads` bucket in Supabase Storage for newly uploaded CSV files.
 * 2. Downloads the pending CSV to a temporary local file.
 * 3. Runs the master V1Pipeline with single worker concurrency for Railway survival.
 * 4. Strictly obeys Rule 1: Checks Supabase and local cache; zero unapproved API requests.
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
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { CSV_UPLOADS_BUCKET, ensureBucketsExist } from '../db/storage.js';
import { V1Pipeline, PipelineResult } from '../orchestrator/pipeline.js';
import { config } from '../config/env.js';

export interface StorageIngestionResult {
  success: boolean;
  processedCount: number;
  processedFile?: string;
  archivePath?: string;
  pipelineResult?: PipelineResult;
  message: string;
}

/**
 * Checks the `csv_uploads` storage bucket, ingests the latest CSV file, and moves it to `archive/`.
 */
export async function ingestCsvFromStorage(): Promise<StorageIngestionResult> {
  if (!isSupabaseConfigured()) {
    console.warn('[Storage CSV Ingestion] ⚠️ Supabase is not configured. Ingestion skipped.');
    return {
      success: false,
      processedCount: 0,
      message: 'Supabase is not configured on the server.',
    };
  }

  await ensureBucketsExist();
  const supabase = getDbClient();

  console.log(`[Storage CSV Ingestion] 🔍 Checking bucket '${CSV_UPLOADS_BUCKET}' for pending CSV files...`);

  // List all files in the root of csv_uploads
  const { data: files, error: listError } = await supabase.storage
    .from(CSV_UPLOADS_BUCKET)
    .list('', {
      limit: 50,
      sortBy: { column: 'created_at', order: 'desc' },
    });

  if (listError) {
    console.error('[Storage CSV Ingestion] ❌ Failed to list bucket:', listError.message);
    throw new Error(`Failed to list ${CSV_UPLOADS_BUCKET}: ${listError.message}`);
  }

  // Filter for valid CSV files not in archive and not hidden
  const pendingCsvFiles = (files || []).filter((f) => {
    if (!f.name || f.name.startsWith('.')) return false;
    const lower = f.name.toLowerCase();
    return lower.endsWith('.csv') && !lower.startsWith('archive');
  });

  if (pendingCsvFiles.length === 0) {
    console.log('[Storage CSV Ingestion] ℹ️ No pending CSV files found in dropzone.');
    return {
      success: true,
      processedCount: 0,
      message: 'No pending CSV files in csv_uploads storage dropzone.',
    };
  }

  const targetFile = pendingCsvFiles[0];
  console.log(`[Storage CSV Ingestion] 📥 Found pending file: "${targetFile.name}". Downloading...`);

  // Download from Supabase Storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(CSV_UPLOADS_BUCKET)
    .download(targetFile.name);

  if (downloadError || !fileData) {
    console.error(`[Storage CSV Ingestion] ❌ Download failed:`, downloadError?.message);
    throw new Error(`Failed to download ${targetFile.name}: ${downloadError?.message}`);
  }

  const arrayBuffer = await fileData.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Write to temporary local file
  const sanitizedName = path.basename(targetFile.name).replace(/[^a-zA-Z0-9._-]/g, '_');
  const tempFilePath = path.join(os.tmpdir(), `csv_dropzone_${Date.now()}_${sanitizedName}`);
  fs.writeFileSync(tempFilePath, buffer);
  console.log(`[Storage CSV Ingestion] 💾 Saved temp CSV to: ${tempFilePath} (${(buffer.length / 1024).toFixed(1)} KB)`);

  let pipelineResult: PipelineResult | undefined;
  try {
    // Run V1Pipeline with single worker concurrency for Railway stability
    const pipeline = new V1Pipeline();
    pipelineResult = await pipeline.runFullPipeline(tempFilePath, config.OUTPUT_DIR, {
      concurrency: config.WORKER_POOL_SIZE || 1,
    });

    console.log(`[Storage CSV Ingestion] ✅ Pipeline completed successfully for ${targetFile.name}.`);

    // Move processed CSV to archive folder in Supabase Storage
    const archiveDest = `archive/${Date.now()}_${sanitizedName}`;
    const { error: moveError } = await supabase.storage
      .from(CSV_UPLOADS_BUCKET)
      .move(targetFile.name, archiveDest);

    if (moveError) {
      console.warn(`[Storage CSV Ingestion] ⚠️ Warning: Could not move file to ${archiveDest}: ${moveError.message}`);
    } else {
      console.log(`[Storage CSV Ingestion] 📦 Archived storage file to: ${archiveDest}`);
    }

    return {
      success: true,
      processedCount: 1,
      processedFile: targetFile.name,
      archivePath: archiveDest,
      pipelineResult,
      message: `Successfully processed and archived ${targetFile.name}.`,
    };
  } finally {
    // Clean up temporary local file
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log(`[Storage CSV Ingestion] 🧹 Cleaned up temp file: ${tempFilePath}`);
      }
    } catch (cleanupErr: any) {
      console.warn(`[Storage CSV Ingestion] ⚠️ Could not remove temp file: ${cleanupErr.message}`);
    }
  }
}

// Direct CLI execution check
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  console.log('--- Starting Storage CSV Ingestion CLI ---');
  ingestCsvFromStorage()
    .then((result) => {
      console.log('Result:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal ingestion error:', err);
      process.exit(1);
    });
}
