import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbClient, isSupabaseConfigured } from './client.js';
import { getProfile } from './profiles.js';
import config from '../config/env.js';

export const PROOFS_BUCKET = config.SUPABASE_STORAGE_BUCKET_PROOFS || 'proofs_web';
export const PROOFS_FAILED_BUCKET = 'proofs_failed';
export const PROOFS_MAIL_BUCKET = 'proofs_mail';
export const CSV_UPLOADS_BUCKET = 'csv_uploads';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_RESUME_BUCKET_PATH = 'resumes/AWL-YASHANTH_resume.pdf';
const RESUME_FETCH_TIMEOUT_MS = 60_000;

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

export function isDemoResumeApplywizzId(applywizzId: string): boolean {
  const id = (applywizzId || '').trim().toUpperCase();
  return id === 'AWL-YASWANTH' || id === 'AWL-YASHANTH';
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
 * Saves a resume PDF to the local resumes folder (dev / demo cache only).
 */
export async function uploadResume(
  applywizzId: string,
  fileBuffer: Buffer,
  _mimeType: string = 'application/pdf'
): Promise<string> {
  const storagePath = `${applywizzId}_resume.pdf`;
  const resumesDir = path.resolve(process.cwd(), config.RESUMES_DIR || 'resumes');
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

  const mailProofDir = path.resolve(process.cwd(), 'output', 'proofs_mail');
  if (!fs.existsSync(mailProofDir)) {
    fs.mkdirSync(mailProofDir, { recursive: true });
  }
  const localPath = path.join(mailProofDir, `${applicationId}_mail_proof.png`);
  fs.writeFileSync(localPath, imageBuffer);
  return `file://${localPath}`;
}

/** Demo-only: legacy Supabase `resumes` bucket object for AWL-YASWANTH. */
async function downloadDemoResumeFromSupabaseBucket(): Promise<Buffer | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = getDbClient();
    const { data, error } = await supabase.storage.from('resumes').download(DEMO_RESUME_BUCKET_PATH);
    if (!error && data) {
      return Buffer.from(await data.arrayBuffer());
    }
  } catch (err: any) {
    console.warn(`[Storage] Demo resume bucket fetch failed: ${err.message}`);
  }
  return null;
}

function readLocalDemoResumeFile(): Buffer | null {
  const candidates = [
    path.resolve(process.cwd(), config.RESUMES_DIR || 'resumes', 'AWL-YASHANTH_resume.pdf'),
    path.resolve(process.cwd(), config.RESUMES_DIR || 'resumes', 'my-resume.pdf'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 100) {
          return fs.readFileSync(filePath);
        }
      } catch {}
    }
  }
  return null;
}

async function loadProfileResumeUrl(applywizzId: string): Promise<string | null> {
  try {
    const profile = await getProfile(applywizzId);
    const url = profile?.resume_url?.trim();
    if (url) return url;
  } catch (err: any) {
    console.warn(`[Storage] Profile resume_url lookup failed for ${applywizzId}: ${err.message}`);
  }
  return null;
}

/**
 * Resolves a stored resume_url to an HTTP(S) download URL (ApplyWizz S3 base for relative keys).
 */
export function resolveResumeHttpUrl(resumeUrl: string): string {
  const trimmed = resumeUrl.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const base = (config.APPLYWIZZ_S3_BASE_URL || '').replace(/\/+$/, '');
  const key = trimmed.replace(/^\/+/, '');
  return `${base}/${key}`;
}

/**
 * HTTP URL for dashboard display from profile.resume_url.
 */
export async function getProfileResumeHttpUrl(applywizzId: string): Promise<string | null> {
  const resumeUrl = await loadProfileResumeUrl(applywizzId);
  if (resumeUrl) {
    return resolveResumeHttpUrl(resumeUrl);
  }
  return null;
}

/**
 * Fetches the master resume PDF bytes using profile.resume_url (on-demand HTTP).
 * AWL-YASWANTH may fall back to the legacy Supabase resumes bucket or local demo file.
 */
export async function fetchResumePdfBuffer(applywizzId: string): Promise<Buffer> {
  if (isDemoResumeApplywizzId(applywizzId)) {
    const demoBuffer = await downloadDemoResumeFromSupabaseBucket();
    if (demoBuffer && demoBuffer.length > 100) {
      return demoBuffer;
    }
    const localDemo = readLocalDemoResumeFile();
    if (localDemo && localDemo.length > 100) {
      return localDemo;
    }
  }

  const resumeUrl = await loadProfileResumeUrl(applywizzId);
  if (!resumeUrl) {
    throw new Error(`No resume_url on profile for ${applywizzId}`);
  }

  console.log('Resume fetched on-demand from profile.resume_url');

  const httpUrl = resolveResumeHttpUrl(resumeUrl);
  const response = await fetch(httpUrl, {
    headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'ApplyWizz-Greenhouse-Automation/1.0' },
    signal: AbortSignal.timeout(RESUME_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Resume download failed HTTP ${response.status} (${httpUrl})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) {
    throw new Error('Downloaded resume PDF is empty or invalid');
  }
  return buffer;
}

/**
 * Downloads candidate master resume to a unique temp file under os.tmpdir().
 * Caller must delete the file after use.
 */
export async function downloadResumeTempFile(applywizzId: string): Promise<string> {
  const buffer = await fetchResumePdfBuffer(applywizzId);
  const tempFilePath = path.join(
    os.tmpdir(),
    `applywizz-${applywizzId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${process.pid}-${Date.now()}.pdf`
  );
  await fs.promises.writeFile(tempFilePath, buffer);
  return tempFilePath;
}

export function isManagedResumeTempFile(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  const tmpRoot = path.normalize(os.tmpdir());
  return normalized.startsWith(tmpRoot) && normalized.includes('applywizz-') && normalized.endsWith('.pdf');
}

export async function deleteResumeTempFile(filePath: string): Promise<void> {
  if (!filePath || !isManagedResumeTempFile(filePath)) return;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (err: any) {
    console.warn(`[Storage] Failed to delete temp resume ${filePath}: ${err.message}`);
  }
}
