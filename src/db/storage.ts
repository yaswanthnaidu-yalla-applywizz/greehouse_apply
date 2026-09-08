/**
 * @fileoverview Supabase Storage bucket operations for resumes and application proof screenshots (V2).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbClient } from './client.js';
import config from '../config/env.js';

export const RESUMES_BUCKET = config.SUPABASE_STORAGE_BUCKET_RESUMES || 'resumes';
export const PROOFS_BUCKET = config.SUPABASE_STORAGE_BUCKET_PROOFS || 'proofs_web';

/**
 * Ensures required storage buckets exist in Supabase.
 * Safe to call idempotently.
 */
export async function ensureBucketsExist(): Promise<void> {
  const supabase = getDbClient();
  const bucketsToEnsure = [
    { name: RESUMES_BUCKET, public: false },
    { name: PROOFS_BUCKET, public: true },
    { name: 'proofs_dry_run', public: true },
  ];

  const { data: existingBuckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    console.warn(`⚠️ Warning: Could not list storage buckets: ${listError.message}`);
    return;
  }

  const existingNames = new Set((existingBuckets || []).map((b) => b.name));

  for (const bucket of bucketsToEnsure) {
    if (!existingNames.has(bucket.name)) {
      const { error: createError } = await supabase.storage.createBucket(bucket.name, {
        public: bucket.public,
      });
      if (createError && !createError.message.includes('already exists')) {
        console.warn(`⚠️ Could not create bucket ${bucket.name}: ${createError.message}`);
      } else {
        console.log(`✅ Ensured storage bucket '${bucket.name}' exists (public: ${bucket.public})`);
      }
    }
  }
}

/**
 * Uploads candidate master resume PDF to the resumes bucket.
 * Destination: resumes/{applywizz_id}_resume.pdf
 *
 * @returns Storage path string
 */
export async function uploadResume(
  applywizzId: string,
  fileBuffer: Buffer,
  mimeType: string = 'application/pdf'
): Promise<string> {
  const supabase = getDbClient();
  const storagePath = `${applywizzId}_resume.pdf`;

  const { error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload resume for ${applywizzId} to storage: ${error.message}`);
  }

  return `${RESUMES_BUCKET}/${storagePath}`;
}

/**
 * Uploads a Greenhouse confirmation screenshot proof to the proofs bucket.
 * Destination: proofs/{application_id}_web.png
 *
 * @returns Public or signed URL for previewing
 */
export async function uploadProof(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const supabase = getDbClient();
  const storagePath = `proofs/${applicationId}_web.png`;

  const { error } = await supabase.storage
    .from(PROOFS_BUCKET)
    .upload(storagePath, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload proof screenshot for ${applicationId}: ${error.message}`);
  }

  const { data } = supabase.storage.from(PROOFS_BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Uploads a dry-run screenshot to the proofs bucket.
 * Destination: dry-run/{application_id}_dryrun.png
 */
export async function uploadDryRunScreenshot(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const supabase = getDbClient();
  const storagePath = `dry-run/${applicationId}_dryrun.png`;

  const { error } = await supabase.storage
    .from('proofs_dry_run')
    .upload(storagePath, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload dry-run screenshot for ${applicationId}: ${error.message}`);
  }

  const { data } = supabase.storage.from('proofs_dry_run').getPublicUrl(storagePath);
  return data.publicUrl;
}

/**
 * Downloads candidate master resume from Supabase Storage to a temporary local file.
 * Returns the absolute path of the temp file on disk.
 */
export async function downloadResumeTempFile(applywizzId: string): Promise<string> {
  const supabase = getDbClient();
  const fileName = `${applywizzId}_resume.pdf`;

  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .download(fileName);

  if (error || !data) {
    throw new Error(`Failed to download resume for ${applywizzId} from storage: ${error?.message}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const tempFilePath = path.join(os.tmpdir(), `greenhouse_resume_${applywizzId}_${Date.now()}.pdf`);
  await fs.promises.writeFile(tempFilePath, buffer);

  return tempFilePath;
}
