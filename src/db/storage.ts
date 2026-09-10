import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbClient, isSupabaseConfigured } from './client.js';
import config from '../config/env.js';

export const PROOFS_BUCKET = config.SUPABASE_STORAGE_BUCKET_PROOFS || 'proofs_web';
export const PROOFS_FAILED_BUCKET = 'proofs_failed';
export const PROOFS_MAIL_BUCKET = 'proofs_mail';
export const CSV_UPLOADS_BUCKET = 'csv_uploads';

/**
 * Ensures required storage buckets exist in Supabase.
 * Optimized: Only maintains 3 proof buckets + 1 private csv_uploads dropzone.
 */
export async function ensureBucketsExist(): Promise<void> {
  if (!isSupabaseConfigured()) {
    return;
  }

  try {
    const supabase = getDbClient();
    const bucketsToEnsure = [
      { name: PROOFS_BUCKET, public: false },
      { name: PROOFS_FAILED_BUCKET, public: false },
      { name: PROOFS_MAIL_BUCKET, public: false },
      { name: CSV_UPLOADS_BUCKET, public: false },
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
          console.log(`✅ Ensured private storage bucket '${bucket.name}' exists`);
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
  _mimeType: string = 'application/pdf'
): Promise<string> {
  const storagePath = `${applywizzId}_resume.pdf`;
  const resumesDir = path.resolve(process.cwd(), 'resumes');
  if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
  }
  const localFile = path.join(resumesDir, storagePath);
  fs.writeFileSync(localFile, fileBuffer);
  return localFile;
}

/**
 * Generates a signed URL valid for 24 hours (86400 seconds) for a private proof screenshot.
 */
export async function getSignedProofUrl(
  bucket: string,
  storagePath: string,
  expiresIn: number = 86400
): Promise<string> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(storagePath, expiresIn);
      if (!error && data?.signedUrl) {
        return data.signedUrl;
      }
    } catch {}
  }
  return '';
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
        const signedUrl = await getSignedProofUrl(PROOFS_BUCKET, storagePath);
        if (signedUrl) return signedUrl;
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
 * Uploads a failure screenshot to the proofs_failed bucket or local folder.
 */
export async function uploadFailedScreenshot(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const storagePath = `${applicationId}_failed.png`;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { error } = await supabase.storage
        .from(PROOFS_FAILED_BUCKET)
        .upload(storagePath, imageBuffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (!error) {
        const signedUrl = await getSignedProofUrl(PROOFS_FAILED_BUCKET, storagePath);
        if (signedUrl) return signedUrl;
        const { data } = supabase.storage.from(PROOFS_FAILED_BUCKET).getPublicUrl(storagePath);
        return data.publicUrl;
      }
    } catch {}
  }

  // Local filesystem fallback
  const failDir = path.resolve(process.cwd(), 'output', 'proofs_failed');
  if (!fs.existsSync(failDir)) {
    fs.mkdirSync(failDir, { recursive: true });
  }
  const localPath = path.join(failDir, `${applicationId}_failed.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/**
 * Uploads a job-opened screenshot to the proofs_job_open bucket or local folder.
 */
export async function uploadJobOpenScreenshot(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const openDir = path.resolve(process.cwd(), 'output', 'proofs');
  if (!fs.existsSync(openDir)) {
    fs.mkdirSync(openDir, { recursive: true });
  }
  const localPath = path.join(openDir, `${applicationId}_open.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/**
 * Uploads a post-submit click screenshot to local output folder.
 */
export async function uploadJobSubmittedScreenshot(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const submittedDir = path.resolve(process.cwd(), 'output', 'proofs');
  if (!fs.existsSync(submittedDir)) {
    fs.mkdirSync(submittedDir, { recursive: true });
  }
  const localPath = path.join(submittedDir, `${applicationId}_submitted.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/**
 * Uploads a confirmation email screenshot proof to the proofs_mail bucket or local folder.
 */
export async function uploadEmailProof(
  applicationId: string,
  imageBuffer: Buffer
): Promise<string> {
  const storagePath = `${applicationId}_mail_proof.png`;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { error } = await supabase.storage
        .from(PROOFS_MAIL_BUCKET)
        .upload(storagePath, imageBuffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (!error) {
        const signedUrl = await getSignedProofUrl(PROOFS_MAIL_BUCKET, storagePath);
        if (signedUrl) return signedUrl;
        const { data } = supabase.storage.from(PROOFS_MAIL_BUCKET).getPublicUrl(storagePath);
        return data.publicUrl;
      }
    } catch {}
  }

  // Local filesystem fallback
  const mailProofDir = path.resolve(process.cwd(), 'output', 'proofs_mail');
  if (!fs.existsSync(mailProofDir)) {
    fs.mkdirSync(mailProofDir, { recursive: true });
  }
  const localPath = path.join(mailProofDir, `${applicationId}_mail_proof.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/**
 * Downloads candidate master resume on-demand to os.tmpdir() using resume_url or local cache.
 * Uses a short-lived cache in os.tmpdir() keyed by applywizz_id.
 */
export async function downloadResumeTempFile(applywizzId: string): Promise<string> {
  const fileName = `${applywizzId}_resume.pdf`;
  const tempFilePath = path.join(os.tmpdir(), fileName);

  // 1. Check if valid resume already exists in temp
  if (fs.existsSync(tempFilePath)) {
    try {
      const stats = fs.statSync(tempFilePath);
      if (stats.size > 100) {
        return tempFilePath;
      }
    } catch {}
  }

  // 2. Local resumes directory fallback (dev / offline)
  const localFile = path.resolve(process.cwd(), 'resumes', fileName);
  if (fs.existsSync(localFile)) {
    try {
      const stats = fs.statSync(localFile);
      if (stats.size > 100) {
        return localFile;
      }
    } catch {}
  }

  // 3. On-demand fetch directly from candidate's remote resume_url
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data: profile } = await supabase
        .from('profiles')
        .select('resume_url')
        .eq('applywizz_id', applywizzId)
        .maybeSingle();

      if (profile?.resume_url) {
        const axios = (await import('axios')).default;
        let targetUrl = profile.resume_url.trim();
        if (!targetUrl.startsWith('http')) {
          const s3Base = (config.APPLYWIZZ_S3_BASE_URL || 'https://applywizz-prod.s3.us-east-2.amazonaws.com').replace(/\/+$/, '');
          targetUrl = `${s3Base}/${encodeURI(targetUrl.replace(/^\/+/, ''))}`;
        }
        const resp = await axios.get(targetUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        const buffer = Buffer.from(resp.data);
        await fs.promises.writeFile(tempFilePath, buffer);
        return tempFilePath;
      }
    } catch (err: any) {
      console.warn(`[Storage] ⚠️ On-demand resume download failed for ${applywizzId}: ${err.message}`);
    }
  }

  return tempFilePath;
}

