import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbClient, isSupabaseConfigured } from './client.js';
import config from '../config/env.js';

export const PROOFS_BUCKET = config.SUPABASE_STORAGE_BUCKET_PROOFS || 'proofs_web';
export const PROOFS_FAILED_BUCKET = 'proofs_failed';
export const PROOFS_MAIL_BUCKET = 'proofs_mail';
export const CSV_UPLOADS_BUCKET = 'csv_uploads';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function webProofStoragePath(applicationId: string): string {
  return `proofs/${applicationId}_web.png`;
}

export function failedProofStoragePath(applicationId: string): string {
  return `${applicationId}_failed.png`;
}

export function emailProofStoragePath(applicationId: string): string {
  return `${applicationId}_mail_proof.png`;
}

export function isApplicationUuid(id: string): boolean {
  return UUID_RE.test(id);
}

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
  const storagePath = webProofStoragePath(applicationId);

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
  const storagePath = failedProofStoragePath(applicationId);

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
  const storagePath = emailProofStoragePath(applicationId);

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
 * Reads or downloads a resume file from Supabase Storage resumes bucket.
 */
export async function downloadResumeFromSupabase(storagePath: string): Promise<Buffer | null> {
  if (!isSupabaseConfigured() || !storagePath) return null;
  try {
    const supabase = getDbClient();
    const cleanPath = storagePath.replace(/^\/+/, '');
    const pathsToTry = [
      cleanPath,
      cleanPath.replace(/^resumes\//, ''),
      cleanPath.startsWith('resumes/') ? cleanPath : `resumes/${cleanPath}`,
    ];
    for (const p of pathsToTry) {
      const { data, error } = await supabase.storage.from('resumes').download(p);
      if (!error && data) {
        const arrayBuf = await data.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
    }
  } catch (err: any) {
    console.warn(`[Storage] ⚠️ Failed to download resume from Supabase Storage (${storagePath}): ${err.message}`);
  }
  return null;
}

/**
 * Gets a signed read URL (valid 24h) for a resume in Supabase Storage.
 */
export async function getSignedResumeUrl(storagePath: string, expiresIn: number = 86400): Promise<string> {
  if (!isSupabaseConfigured() || !storagePath) return '';
  try {
    const supabase = getDbClient();
    const cleanPath = storagePath.replace(/^\/+/, '');
    const pathsToTry = [
      cleanPath,
      cleanPath.replace(/^resumes\//, ''),
      cleanPath.startsWith('resumes/') ? cleanPath : `resumes/${cleanPath}`,
    ];
    for (const p of pathsToTry) {
      const { data, error } = await supabase.storage.from('resumes').createSignedUrl(p, expiresIn);
      if (!error && data?.signedUrl) {
        return data.signedUrl;
      }
    }
  } catch {}
  return '';
}

/**
 * Downloads candidate master resume on-demand to os.tmpdir() using Supabase Storage, resume_url or local cache.
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

  // 2. Fetch directly from Supabase Storage (resumes bucket)
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data: profile } = await supabase
        .from('profiles')
        .select('resume_url, resume_storage_path')
        .or(`applywizz_id.eq.${applywizzId},applywizz_id.ilike.${applywizzId}`)
        .maybeSingle();

      const candidatePath =
        profile?.resume_storage_path ||
        profile?.resume_url ||
        (applywizzId === 'AWL-YASWANTH' || applywizzId === 'AWL-YASHANTH'
          ? 'resumes/AWL-YASHANTH_resume.pdf'
          : `${applywizzId}_resume.pdf`);

      const resumeBuffer = await downloadResumeFromSupabase(candidatePath);
      if (resumeBuffer && resumeBuffer.length > 100) {
        await fs.promises.writeFile(tempFilePath, resumeBuffer);
        return tempFilePath;
      }
    } catch (err: any) {
      console.warn(`[Storage] ⚠️ Supabase Storage resume fetch failed for ${applywizzId}: ${err.message}`);
    }
  }

  // 3. Local resumes directory fallback (dev / offline)
  const localFile = path.resolve(process.cwd(), 'resumes', fileName);
  if (fs.existsSync(localFile)) {
    try {
      const stats = fs.statSync(localFile);
      if (stats.size > 100) {
        return localFile;
      }
    } catch {}
  }

  // Also check local my-resume.pdf or AWL-YASHANTH_resume.pdf fallback for demo candidate
  if (applywizzId === 'AWL-YASWANTH' || applywizzId === 'AWL-YASHANTH') {
    const demoCandidates = [
      path.resolve(process.cwd(), 'resumes', 'AWL-YASHANTH_resume.pdf'),
      path.resolve(process.cwd(), 'resumes', 'my-resume.pdf'),
      path.resolve(process.cwd(), 'resumes', 'my-resume.pdf.pdf'),
    ];
    for (const d of demoCandidates) {
      if (fs.existsSync(d)) {
        try {
          const stats = fs.statSync(d);
          if (stats.size > 100) return d;
        } catch {}
      }
    }
  }

  return tempFilePath;
}

