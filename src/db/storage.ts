import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDbClient, isSupabaseConfigured } from './client.js';
import { isSandboxMode } from './sandboxClient.js';
import { getProfile } from './profiles.js';
import config from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { resolveResumeDomain, buildResumeStorageFilename } from '../utils/resumeNaming.js';

const log = createLogger('Storage');

export const PROOFS_BUCKET = config.SUPABASE_STORAGE_BUCKET_PROOFS || 'proofs_web';
export const PROOFS_FAILED_BUCKET = 'proofs_failed';
export const PROOFS_MAIL_BUCKET = 'proofs_mail';
export const CSV_UPLOADS_BUCKET = 'csv_uploads';
export const RESUMES_BUCKET = 'resumes';

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
  return id === 'AWL-YASWANTH' || id === 'AWL-YASHANTH' || id === 'AWL-31428';
}

export interface ResumeNamingProfile {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  workExperience?: Array<{ title?: string | null }>;
}



export function resumeDomainShortcode(profile?: ResumeNamingProfile): string {
  const title = profile?.jobTitle || profile?.workExperience?.[0]?.title || '';
  return resolveResumeDomain(title);
}

export function resumeStorageFilename(
  applywizzId: string,
  profile?: ResumeNamingProfile
): string {
  return buildResumeStorageFilename(profile, applywizzId);
}

/**
 * Purges all files in the Supabase Storage resumes bucket and clears the local resumes cache.
 */
export async function purgeResumesBucket(options?: {
  resumesDir?: string;
}): Promise<{ deletedCount: number; clearedLocalCount: number }> {
  let deletedCount = 0;
  let clearedLocalCount = 0;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let hasMore = true;
      let offset = 0;
      const pageSize = 1000;

      while (hasMore) {
        const { data: files, error: listError } = await supabase.storage
          .from(RESUMES_BUCKET)
          .list('', { limit: pageSize, offset, sortBy: { column: 'name', order: 'asc' } });

        if (listError) {
          log.warn(`[Storage] Failed to list resumes bucket for purge: ${listError.message}`);
          break;
        }

        if (!files || files.length === 0) {
          break;
        }

        const validFileNames = files
          .map((f: any) => f.name)
          .filter((name: string) => name && !name.startsWith('.') && name !== '.emptyFolderPlaceholder');

        if (validFileNames.length > 0) {
          const { error: removeError } = await supabase.storage
            .from(RESUMES_BUCKET)
            .remove(validFileNames);

          if (removeError) {
            log.warn(`[Storage] Failed to remove batch of ${validFileNames.length} resumes: ${removeError.message}`);
          } else {
            deletedCount += validFileNames.length;
          }
        }

        if (files.length < pageSize) {
          hasMore = false;
        } else {
          offset += pageSize;
        }
      }
      log.info(`[Storage] 🧹 Purged ${deletedCount} objects from Supabase Storage '${RESUMES_BUCKET}' bucket.`);
    } catch (err: any) {
      log.warn(`[Storage] Error purging Supabase resumes bucket: ${err.message}`);
    }
  }

  // Clear local resumes cache folder
  try {
    const resumesDir = path.resolve(process.cwd(), options?.resumesDir || config.RESUMES_DIR || 'resumes');
    if (fs.existsSync(resumesDir)) {
      const entries = fs.readdirSync(resumesDir);
      for (const entry of entries) {
        if (
          entry.toLowerCase().endsWith('.pdf') ||
          entry.toLowerCase().endsWith('.doc') ||
          entry.toLowerCase().endsWith('.docx')
        ) {
          try {
            fs.unlinkSync(path.join(resumesDir, entry));
            clearedLocalCount++;
          } catch {}
        }
      }
      log.info(`[Storage] 🧹 Cleared ${clearedLocalCount} files from local resumes folder.`);
    }
  } catch (err: any) {
    log.warn(`[Storage] Error clearing local resumes folder: ${err.message}`);
  }

  return { deletedCount, clearedLocalCount };
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
      { name: RESUMES_BUCKET, public: false },
    ];

    const { data: existingBuckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      log.warn(`⚠️ Warning: Could not list storage buckets: ${listError.message}`);
      return;
    }

    const existingNames = new Set((existingBuckets || []).map((b) => b.name));

    for (const bucket of bucketsToEnsure) {
      if (!existingNames.has(bucket.name)) {
        const { error: createError } = await supabase.storage.createBucket(bucket.name, {
          public: bucket.public,
        });
        if (createError && !createError.message.includes('already exists')) {
          log.warn(`⚠️ Could not create bucket ${bucket.name}: ${createError.message}`);
        } else {
          log.info(`✅ Ensured private storage bucket '${bucket.name}' exists`);
        }
      }
    }
  } catch (err: any) {
    log.warn(`⚠️ Storage buckets check skipped: ${err.message}`);
  }
}

/**
 * Saves a resume PDF to the local resumes folder (dev / demo cache only).
 */
export async function uploadResume(
  applywizzId: string,
  fileBuffer: Buffer,
  mimeType: string = 'application/pdf',
  profile?: ResumeNamingProfile
): Promise<string> {
  const storagePath = `${RESUMES_BUCKET}/${resumeStorageFilename(applywizzId, profile)}`;
  const resumesDir = path.resolve(process.cwd(), config.RESUMES_DIR || 'resumes');
  if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
  }
  const localFile = path.join(resumesDir, path.basename(storagePath));

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data: existing, error: listError } = await supabase.storage
        .from(RESUMES_BUCKET)
        .list('', { limit: 1000, search: path.basename(storagePath) });
      if (!listError && existing?.some((entry) => entry.name === path.basename(storagePath))) {
        if (!fs.existsSync(localFile) || fs.statSync(localFile).size <= 100) {
          await fs.promises.writeFile(localFile, fileBuffer);
        }
        return storagePath;
      }

      const { error: uploadError } = await supabase.storage
        .from(RESUMES_BUCKET)
        .upload(path.basename(storagePath), fileBuffer, {
          contentType: mimeType,
          upsert: false,
        });
      if (!uploadError || /already exists|duplicate/i.test(uploadError.message)) {
        if (!fs.existsSync(localFile) || fs.statSync(localFile).size <= 100) {
          await fs.promises.writeFile(localFile, fileBuffer);
        }
        return storagePath;
      }
      log.warn(`[Storage] Resume upload failed for ${storagePath}: ${uploadError.message}`);
    } catch (err: any) {
      log.warn(`[Storage] Resume upload check failed for ${storagePath}: ${err.message}`);
    }
  }

  if (!fs.existsSync(localFile) || fs.statSync(localFile).size <= 100) {
    await fs.promises.writeFile(localFile, fileBuffer);
  }
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
      if (error) {
        log.warn(`[Storage] Proof signed URL failed for ${bucket}/${storagePath}: ${error.message}`);
      }
    } catch (err: any) {
      log.warn(`[Storage] Proof signed URL request failed for ${bucket}/${storagePath}: ${err.message}`);
    }
  }
  return '';
}

function localProofDirectory(bucket: string): string {
  if (bucket === PROOFS_FAILED_BUCKET) return 'proofs_failed';
  if (bucket === PROOFS_MAIL_BUCKET) return 'proofs_mail';
  if (bucket === 'proofs_dry_run') return 'proofs_dry_run';
  return 'proofs';
}

/**
 * Downloads a proof screenshot binary buffer from Supabase Storage or local disk.
 */
export async function downloadProofBuffer(
  bucket: string,
  storagePath: string
): Promise<Buffer | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase.storage.from(bucket).download(storagePath);
      if (!error && data) {
        const arrayBuf = await data.arrayBuffer();
        return Buffer.from(arrayBuf);
      }
      if (error) {
        log.warn(`[Storage] Proof download failed for ${bucket}/${storagePath}: ${error.message}`);
      }
    } catch (err: any) {
      log.warn(`[Storage] Proof download request failed for ${bucket}/${storagePath}: ${err.message}`);
    }
  }

  // Local filesystem fallback
  try {
    const filename = path.basename(storagePath);
    const localPath = path.resolve(process.cwd(), 'output', localProofDirectory(bucket), filename);
    if (fs.existsSync(localPath)) {
      return fs.readFileSync(localPath);
    }
  } catch (err: any) {
    log.warn(`[Storage] Local proof read failed for ${bucket}/${storagePath}: ${err.message}`);
  }

  return null;
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
      log.warn(`[Storage] Web proof upload failed for ${storagePath}: ${error.message}`);
    } catch (err: any) {
      log.warn(`[Storage] Web proof upload request failed for ${storagePath}: ${err.message}`);
    }
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
      log.warn(`[Storage] Dry-run proof upload failed for ${storagePath}: ${error.message}`);
    } catch (err: any) {
      log.warn(`[Storage] Dry-run proof upload request failed for ${storagePath}: ${err.message}`);
    }
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
      log.warn(`[Storage] Failure proof upload failed for ${storagePath}: ${error.message}`);
    } catch (err: any) {
      log.warn(`[Storage] Failure proof upload request failed for ${storagePath}: ${err.message}`);
    }
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
      log.warn(`[Storage] Email proof upload failed for ${storagePath}: ${error.message}`);
    } catch (err: any) {
      log.warn(`[Storage] Email proof upload request failed for ${storagePath}: ${err.message}`);
    }
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
    log.warn(`[Storage] Demo resume bucket fetch failed: ${err.message}`);
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
    log.warn(`[Storage] Profile resume_url lookup failed for ${applywizzId}: ${err.message}`);
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
 * Downloads a candidate resume directly from the Supabase Storage 'resumes' bucket.
 */
export async function downloadResumeFromSupabaseStorage(storagePath: string): Promise<Buffer | null> {
  if (!storagePath || !isSupabaseConfigured()) return null;
  try {
    const supabase = getDbClient();
    const cleanPath = storagePath.replace(/^resumes\//, '').trim();
    if (!cleanPath) return null;
    const { data, error } = await supabase.storage.from('resumes').download(cleanPath);
    if (!error && data) {
      const buffer = Buffer.from(await data.arrayBuffer());
      if (buffer.length >= 100) {
        log.info(`[Storage] Resume successfully downloaded from Supabase Storage (${cleanPath})`);
        return buffer;
      }
    }
  } catch (err: any) {
    log.warn(`[Storage] Supabase Storage resume download failed for ${storagePath}: ${err.message}`);
  }
  return null;
}

/**
 * Fetches the master resume PDF bytes using profile.resume_url (on-demand HTTP).
 * Falls back to Supabase Storage resumes bucket if HTTP download fails or returns non-2xx.
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

  const profile = await getProfile(applywizzId).catch(() => null);

  // Fast check: check local resumes folder first (zero network latency, avoids S3 timeouts)
  if (profile?.resume_storage_path) {
    const localPath = path.resolve(process.cwd(), config.RESUMES_DIR || 'resumes', path.basename(profile.resume_storage_path));
    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 100) {
      log.info(`[Storage] Resume loaded directly from local resumes cache: ${localPath}`);
      return fs.readFileSync(localPath);
    }
  }

  const resumeUrl = profile?.resume_url?.trim();

  let httpError: Error | null = null;
  if (resumeUrl) {
    try {
      const httpUrl = resolveResumeHttpUrl(resumeUrl);
      const response = await fetch(httpUrl, {
        headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'ApplyWizz-Greenhouse-Automation/1.0' },
        signal: AbortSignal.timeout(RESUME_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length >= 100) {
          log.info('Resume fetched on-demand from profile.resume_url');
          return buffer;
        }
      } else {
        httpError = new Error(`Resume download failed HTTP ${response.status} (${httpUrl})`);
      }
    } catch (err: any) {
      httpError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // Resilient fallback to Supabase Storage resumes bucket
  if (profile?.resume_storage_path) {
    log.info(`[Storage] Attempting Supabase Storage fallback for ${applywizzId} (${profile.resume_storage_path})`);
    const storageBuffer = await downloadResumeFromSupabaseStorage(profile.resume_storage_path);
    if (storageBuffer) {
      return storageBuffer;
    }
  }

  if (httpError) {
    throw httpError;
  }
  throw new Error(`No resume_url or valid resume_storage_path on profile for ${applywizzId}`);
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
    log.warn(`[Storage] Failed to delete temp resume ${filePath}: ${err.message}`);
  }
}

/**
 * Sanitizes an operator-uploaded filename for storage, removing directory traversal and unsafe characters.
 */
export function sanitizeUploadFilename(filename: string): string {
  const base = path.basename(filename || 'uploaded_document');
  const ext = path.extname(base);
  const nameWithoutExt = path.basename(base, ext);
  const cleanName = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const cleanExt = ext.replace(/[^a-zA-Z0-9.]/g, '');
  return `${cleanName || 'document'}${cleanExt}`;
}

/**
 * Uploads an operator-supplied document into Supabase Storage 'resumes' bucket under operator_uploads/,
 * with local filesystem fallback for sandbox / offline mode.
 */
export async function uploadOperatorFieldFile(
  applywizzId: string,
  applicationId: string,
  fieldId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string = 'application/octet-stream',
  dbClient?: any
): Promise<{ storagePath: string; url?: string }> {
  const safeFilename = sanitizeUploadFilename(filename);
  const cleanApplywizz = (applywizzId || 'UNKNOWN').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanAppId = (applicationId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanField = (fieldId || 'file').replace(/[^a-zA-Z0-9_-]/g, '_');

  const relativeObjectPath = `operator_uploads/${cleanApplywizz}/${cleanAppId}_${cleanField}_${safeFilename}`;
  const fullStoragePath = relativeObjectPath;

  if (isSupabaseConfigured() && !isSandboxMode()) {
    try {
      const supabase = dbClient || getDbClient();
      const { error } = await supabase.storage
        .from(RESUMES_BUCKET)
        .upload(relativeObjectPath, buffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (!error) {
        log.info(`[Storage] Uploaded operator file to Supabase Storage: ${relativeObjectPath}`);
        const signedUrl = await getSignedProofUrl(RESUMES_BUCKET, relativeObjectPath);
        return { storagePath: fullStoragePath, url: signedUrl || undefined };
      }
      log.warn(`[Storage] Supabase upload failed (${error.message}), falling back to local file`);
    } catch (err: any) {
      log.warn(`[Storage] Error uploading to Supabase Storage: ${err.message}`);
    }
  }

  // Local filesystem fallback
  const localDirCandidates = [
    path.resolve(process.cwd(), 'resumes', 'operator_uploads', cleanApplywizz),
    path.join(os.tmpdir(), 'resumes', 'operator_uploads', cleanApplywizz),
  ];

  let localSavedPath = '';
  for (const localDir of localDirCandidates) {
    try {
      fs.mkdirSync(localDir, { recursive: true });
      const localFilePath = path.join(localDir, `${cleanAppId}_${cleanField}_${safeFilename}`);
      fs.writeFileSync(localFilePath, buffer);
      localSavedPath = localFilePath;
      log.info(`[Storage] Saved operator file locally: ${localFilePath}`);
      break;
    } catch (err: any) {
      log.warn(`[Storage] Could not write to ${localDir}: ${err.message}`);
    }
  }

  if (!localSavedPath) {
    throw new Error(`Failed to save operator file locally in any candidate directory`);
  }

  return { storagePath: fullStoragePath };
}

/**
 * Downloads an operator-uploaded file given its relative storage path.
 * Checks local filesystem cache first, then Supabase Storage.
 */
export async function downloadOperatorFieldFile(
  storagePath: string,
  dbClient?: any
): Promise<Buffer> {
  if (!storagePath) {
    throw new Error('No storagePath provided for downloadOperatorFieldFile');
  }

  const cleanPath = storagePath.replace(/^resumes\//, '').trim();

  // 1. Check local directory fallback
  const localCandidates = [
    path.resolve(process.cwd(), 'resumes', cleanPath),
    path.resolve(process.cwd(), cleanPath),
    path.join(os.tmpdir(), 'resumes', cleanPath),
    path.join(os.tmpdir(), cleanPath),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate);
    }
  }

  // 2. Fetch from Supabase Storage
  if (isSupabaseConfigured()) {
    try {
      const supabase = dbClient || getDbClient();
      const { data, error } = await supabase.storage.from(RESUMES_BUCKET).download(cleanPath);
      if (!error && data) {
        return Buffer.from(await data.arrayBuffer());
      }
      if (error) {
        log.warn(`[Storage] Supabase download error for ${cleanPath}: ${error.message}`);
      }
    } catch (err: any) {
      log.warn(`[Storage] Error downloading operator file from Supabase: ${err.message}`);
    }
  }

  throw new Error(`Could not find operator uploaded file at storage path: ${storagePath}`);
}

/**
 * Updates a candidate profile's resume_storage_path in Supabase when an operator uploads a resume.
 */
export async function syncUploadedResumeToProfile(
  applywizzId: string,
  storagePath: string,
  dbClient?: any
): Promise<void> {
  if (!applywizzId || !storagePath) return;
  try {
    const supabase = dbClient || (isSupabaseConfigured() ? getDbClient() : null);
    if (!supabase) return;

    const { error } = await supabase
      .from('profiles')
      .update({
        resume_storage_path: storagePath,
        updated_at: new Date().toISOString(),
      })
      .eq('applywizz_id', applywizzId);

    if (error) {
      log.warn(`[Storage] Failed to update profile resume_storage_path for ${applywizzId}: ${error.message}`);
    } else {
      log.info(`[Storage] Synchronized uploaded resume to candidate profile: ${applywizzId} -> ${storagePath}`);
    }
  } catch (err: any) {
    log.warn(`[Storage] Error updating profile resume_storage_path: ${err.message}`);
  }
}
