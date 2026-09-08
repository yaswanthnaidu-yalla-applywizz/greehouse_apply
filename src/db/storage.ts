import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbClient, isSupabaseConfigured } from './client.js';
import config from '../config/env.js';

export const RESUMES_BUCKET = config.SUPABASE_STORAGE_BUCKET_RESUMES || 'resumes';
export const PROOFS_BUCKET = config.SUPABASE_STORAGE_BUCKET_PROOFS || 'proofs_web';

/**
 * Ensures required storage buckets exist in Supabase.
 * Safe to call idempotently.
 */
export async function ensureBucketsExist(): Promise<void> {
  if (!isSupabaseConfigured()) {
    return;
  }

  try {
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
  } catch (err: any) {
    console.warn(`⚠️ Storage buckets check skipped: ${err.message}`);
  }
}

/**
 * Uploads candidate master resume PDF to the resumes bucket or local resumes folder.
 */
export async function uploadResume(
  applywizzId: string,
  fileBuffer: Buffer,
  mimeType: string = 'application/pdf'
): Promise<string> {
  const storagePath = `${applywizzId}_resume.pdf`;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { error } = await supabase.storage
        .from(RESUMES_BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (!error) {
        return `${RESUMES_BUCKET}/${storagePath}`;
      }
    } catch {}
  }

  // Local filesystem fallback
  const resumesDir = path.resolve(process.cwd(), 'resumes');
  if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
  }
  const localFile = path.join(resumesDir, storagePath);
  fs.writeFileSync(localFile, fileBuffer);
  return localFile;
}

/**
 * Uploads a Greenhouse confirmation screenshot proof to the proofs bucket or local folder.
 */
export async function uploadProof(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const storagePath = `proofs/${applicationId}_web.png`;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { error } = await supabase.storage
        .from(PROOFS_BUCKET)
        .upload(storagePath, imageBuffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (!error) {
        const { data } = supabase.storage.from(PROOFS_BUCKET).getPublicUrl(storagePath);
        return data.publicUrl;
      }
    } catch {}
  }

  // Local filesystem fallback
  const proofDir = path.resolve(process.cwd(), 'output', 'proofs');
  if (!fs.existsSync(proofDir)) {
    fs.mkdirSync(proofDir, { recursive: true });
  }
  const localPath = path.join(proofDir, `${applicationId}_web.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/**
 * Uploads a dry-run screenshot to the proofs bucket or local folder.
 */
export async function uploadDryRunScreenshot(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const storagePath = `dry-run/${applicationId}_dryrun.png`;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { error } = await supabase.storage
        .from('proofs_dry_run')
        .upload(storagePath, imageBuffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (!error) {
        const { data } = supabase.storage.from('proofs_dry_run').getPublicUrl(storagePath);
        return data.publicUrl;
      }
    } catch {}
  }

  // Local filesystem fallback
  const dryRunDir = path.resolve(process.cwd(), 'output', 'proofs_dry_run');
  if (!fs.existsSync(dryRunDir)) {
    fs.mkdirSync(dryRunDir, { recursive: true });
  }
  const localPath = path.join(dryRunDir, `${applicationId}_dryrun.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/**
 * Downloads candidate master resume from Supabase Storage or returns local disk file.
 * Returns the absolute path of the temp file or local file on disk.
 */
export async function downloadResumeTempFile(applywizzId: string): Promise<string> {
  // 1. Check local resumes directory first
  const localFile = path.resolve(process.cwd(), 'resumes', `${applywizzId}_resume.pdf`);
  if (fs.existsSync(localFile)) {
    return localFile;
  }

  // 2. Download from Supabase Storage if configured
  if (isSupabaseConfigured()) {
    const supabase = getDbClient();
    const fileName = `${applywizzId}_resume.pdf`;

    const { data, error } = await supabase.storage
      .from(RESUMES_BUCKET)
      .download(fileName);

    if (!error && data) {
      const arrayBuffer = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const tempFilePath = path.join(os.tmpdir(), `greenhouse_resume_${applywizzId}_${Date.now()}.pdf`);
      await fs.promises.writeFile(tempFilePath, buffer);
      return tempFilePath;
    }
  }

  throw new Error(`Resume PDF not found for ${applywizzId} locally or in cloud storage.`);
}

