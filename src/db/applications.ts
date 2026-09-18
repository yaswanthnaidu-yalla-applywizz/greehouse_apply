/**
 * @fileoverview Database operations for candidate job applications and status lifecycle (V2).
 * Table: `candidate_applications`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';
import { hydrateApplicationResolvedFields } from './applicationFieldHydration.js';
import {
  getSignedProofUrl,
  PROOFS_BUCKET,
  PROOFS_FAILED_BUCKET,
  PROOFS_MAIL_BUCKET,
  webProofStoragePath,
  failedProofStoragePath,
  emailProofStoragePath,
  isApplicationUuid,
} from './storage.js';
import { createLogger } from '../utils/logger.js';
import { hasAnyNonEmptyResolvedField } from '../utils/resolvedFields.js';
import {
  assertEligibleForSubmission,
  SubmissionEligibilityBlockedError,
} from '../submission/submissionEligibilityGate.js';

export { SubmissionEligibilityBlockedError };
import { applicationRowHasPersistedResolution } from '../dashboard/candidateQueueFilter.js';
import {
  normalizeOperatorErrorMessage,
  OperatorErrors,
  statusShouldPersistOperatorError,
} from '../operator/operatorErrorMessages.js';

const log = createLogger('Applications');

export type ApplicationStatus =
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'DRY_RUN_COMPLETE'
  | 'QUEUED'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'EXPIRED'
  | 'OTP_REQUIRED'
  | 'CAPTCHA_TIMEOUT'
  | 'CAPTCHA_REQUIRED'
  | 'EMAIL_PROOF_PENDING'
  | 'EMAIL_UNVERIFIED'
  | 'SKIPPED';

export type EmailProofStatus = 'pending' | 'captured' | 'timed_out' | 'manual_review_needed';

export const SUBMITTED_TODAY_STATUSES: readonly ApplicationStatus[] = [
  'QUEUED',
  'APPLYING',
  'APPLIED',
  'EMAIL_PROOF_PENDING',
  'EMAIL_UNVERIFIED',
  'DRY_RUN_COMPLETE',
];

export interface EmailProofJson {
  from: string;
  to?: string;
  subject: string;
  received_at: string;
  body_text: string;
  body_html?: string;
}

export interface ApplicationRow {
  id?: string;
  applywizz_id: string;
  template_id?: string | null;
  job_url: string;
  company_name?: string | null;
  job_title?: string | null;
  status: ApplicationStatus;
  submission_order?: number | null;
  assigned_ca_email?: string | null;
  resolved_fields: any[];
  proof_web_url?: string | null;
  proof_captured_at?: string | null;
  proof_failed_url?: string | null;
  proof_failed_captured_at?: string | null;
  proof_email_url?: string | null;
  proof_email_json?: EmailProofJson | null;
  proof_email_captured_at?: string | null;
  email_proof_status?: EmailProofStatus | null;
  manual_email_review?: boolean;
  email_proof_attempted_at?: string | null;
  error_message?: string | null;
  dry_run_screenshot_url?: string | null;
  has_manual_edits?: boolean;
  reviewed_at?: string | null;
  submitted_at?: string | null;
  created_at?: string;
  updated_at?: string;
  csv_job_score?: number | null;
  field_count?: number | null;
  retry_count?: number | null;
}

/**
 * Calculates UTC ISO string bounds for an Asia/Kolkata (IST, UTC+5:30) calendar date (YYYY-MM-DD).
 */
export function getISTDateRangeUtc(dateStr: string): { startIso: string; endIso: string } {
  const [yyyy, mm, dd] = dateStr.split('-').map(Number);
  const startDate = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0) - (5.5 * 60 * 60 * 1000));
  const endDate = new Date(Date.UTC(yyyy, mm - 1, dd, 23, 59, 59, 999) - (5.5 * 60 * 60 * 1000));
  return {
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
  };
}

export async function countSubmittedApplicationsSince(
  startIso: string,
  assignedCaEmails?: string[]
): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const emails = assignedCaEmails?.map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails && emails.length === 0) return 0;

  try {
    let query = getDbClient()
      .from('candidate_applications')
      .select('id', { count: 'exact', head: true })
      .in('status', [...SUBMITTED_TODAY_STATUSES])
      .gte('updated_at', startIso);
    if (emails) query = query.in('assigned_ca_email', emails);
    const { count, error } = await query;
    if (error) {
      log.warn(`[DB] submitted-today count failed: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  } catch (err: any) {
    log.warn(`[DB] submitted-today count exception: ${err?.message}`);
    return 0;
  }
}

export async function countSubmittedApplicationsByOperatorSince(
  startIso: string,
  assignedCaEmails?: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!isSupabaseConfigured()) return result;
  const emails = assignedCaEmails?.map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails && emails.length === 0) return result;

  try {
    let query = getDbClient()
      .from('candidate_applications')
      .select('assigned_ca_email')
      .in('status', [...SUBMITTED_TODAY_STATUSES])
      .gte('updated_at', startIso);
    if (emails) query = query.in('assigned_ca_email', emails);
    const { data, error } = await query;
    if (error) {
      log.warn(`[DB] submitted-today operator counts failed: ${error.message}`);
      return result;
    }
    for (const row of data || []) {
      const email = String(row.assigned_ca_email || '').trim().toLowerCase();
      if (email) result.set(email, (result.get(email) || 0) + 1);
    }
  } catch (err: any) {
    log.warn(`[DB] submitted-today operator counts exception: ${err?.message}`);
  }
  return result;
}

export interface CreatedAtRangeFilter {
  startIso: string;
  endIso: string | null;
}

type GteLteQuery = {
  gte(column: string, value: string): GteLteQuery;
  lte(column: string, value: string): GteLteQuery;
};

export function applyCreatedAtRangeFilter<T extends GteLteQuery>(
  query: T,
  range: CreatedAtRangeFilter
): T {
  let q = query.gte('created_at', range.startIso) as T;
  if (range.endIso) {
    q = q.lte('created_at', range.endIso) as T;
  }
  return q;
}

export function rowCreatedAtInRange(
  row: { created_at?: string | null },
  range: CreatedAtRangeFilter
): boolean {
  const ts = row.created_at;
  if (!ts) return false;
  const time = new Date(ts).getTime();
  if (time < new Date(range.startIso).getTime()) return false;
  if (range.endIso && time > new Date(range.endIso).getTime()) return false;
  return true;
}

const memoryApplications = new Map<string, ApplicationRow>();

/**
 * Caches an application record in local memory for dry-run/submit lookups.
 */
export function cacheApplicationLocally(app: ApplicationRow): ApplicationRow {
  const id =
    app.id ||
    `${app.applywizz_id}_${Buffer.from(app.job_url || '').toString('base64url').slice(0, 16)}`;
  const cached = { ...app, id };
  memoryApplications.set(id, cached);
  if (app.applywizz_id && app.applywizz_id !== id) {
    memoryApplications.set(app.applywizz_id, cached);
  }
  return cached;
}

/**
 * Upserts a candidate application record into Supabase or local memory.
 * Keyed by unique constraint (applywizz_id, job_url).
 */
export async function upsertApplication(
  app: Partial<ApplicationRow> & { applywizz_id: string; job_url: string; resolved_fields: any[] }
): Promise<ApplicationRow> {
  const payload: any = {
    status: (app.status || 'READY_FOR_REVIEW') as ApplicationStatus,
    ...app,
    updated_at: new Date().toISOString(),
  };

  if (
    payload.status !== 'SKIPPED' &&
    Array.isArray(payload.resolved_fields) &&
    !hasAnyNonEmptyResolvedField(payload.resolved_fields) &&
    payload.applywizz_id &&
    payload.job_url &&
    isSupabaseConfigured()
  ) {
    try {
      const supabase = getDbClient();
      const { data: existing } = await supabase
        .from('candidate_applications')
        .select('resolved_fields')
        .eq('applywizz_id', payload.applywizz_id)
        .eq('job_url', payload.job_url)
        .maybeSingle();
      const existingFields = existing?.resolved_fields;
      if (hasAnyNonEmptyResolvedField(existingFields)) {
        payload.resolved_fields = existingFields;
      }
    } catch {
      /* fall through — empty payload is acceptable for brand-new rows */
    }
  }

  if (payload.status === 'SKIPPED' && !payload.error_message) {
    payload.error_message = OperatorErrors.TOO_MANY_QUESTIONS;
  } else if (payload.error_message !== undefined && payload.error_message !== null && payload.error_message !== '') {
    payload.error_message = normalizeOperatorErrorMessage(payload.error_message, payload.status);
  } else if (statusShouldPersistOperatorError(payload.status)) {
    payload.error_message = normalizeOperatorErrorMessage(null, payload.status);
  } else if (
    payload.status === 'READY_FOR_REVIEW' &&
    (payload.error_message === undefined || payload.error_message === null) &&
    Array.isArray(payload.resolved_fields) &&
    payload.resolved_fields.length === 0
  ) {
    payload.error_message = OperatorErrors.RESOLUTION_PENDING;
  }

  // Only pass id to Supabase if it's already a valid UUID
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id || '');
  if (!isUuid) {
    delete payload.id;
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .upsert(payload, { onConflict: 'applywizz_id,job_url' })
        .select()
        .single();

      if (!error && data) {
        const row = data as ApplicationRow;
        memoryApplications.set(row.id!, row);
        const compositeKey = `${row.applywizz_id}_${Buffer.from(row.job_url).toString('base64url').slice(0, 16)}`;
        memoryApplications.set(compositeKey, row);
        return row;
      }
      if (error) {
        const missingProfileFk = /candidate_applications_applywizz_id_fkey/i.test(error.message);
        if (missingProfileFk) {
          log.warn(
            `[DB] upsertApplication skipped — no profiles row for ${app.applywizz_id} (${app.job_url}). Sync the candidate before creating applications.`
          );
        } else {
          log.error(`[DB] upsertApplication Supabase error (${app.applywizz_id}, ${app.job_url}):`, error.message);
        }
      }
    } catch (err: any) {
      log.warn(`[DB] upsertApplication exception:`, err);
    }
  }

  const fallbackId = app.id || `${app.applywizz_id}_${Buffer.from(app.job_url).toString('base64url').slice(0, 16)}`;
  payload.id = fallbackId;
  memoryApplications.set(fallbackId, payload);
  return payload as ApplicationRow;
}


/**
 * Retrieves a candidate application by primary UUID or candidate applywizz_id.
 */
export async function getApplication(id: string, jobUrl?: string): Promise<ApplicationRow | null> {
  const cleanId = (id || '').trim();
  if (!cleanId) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);
  const targetJobUrl = jobUrl || memoryApplications.get(cleanId)?.job_url;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      if (isUuid) {
        const { data, error } = await supabase
          .from('candidate_applications')
          .select('*')
          .eq('id', cleanId)
          .maybeSingle();

        if (!error && data) {
          const mem = memoryApplications.get(cleanId);
          if (
            mem &&
            mem.updated_at &&
            data.updated_at &&
            new Date(mem.updated_at).getTime() > new Date(data.updated_at).getTime()
          ) {
            return { ...(data as ApplicationRow), ...mem };
          }
          return data as ApplicationRow;
        }
      }

      // Query by applywizz_id
      const candidateId = cleanId.includes('_') ? cleanId.split('_')[0] : cleanId;
      let query = supabase
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', candidateId);

      if (targetJobUrl) {
        query = query.eq('job_url', targetJobUrl);
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        const mem = memoryApplications.get(data.id) || memoryApplications.get(cleanId);
        if (
          mem &&
          mem.updated_at &&
          data.updated_at &&
          new Date(mem.updated_at).getTime() > new Date(data.updated_at).getTime()
        ) {
          return { ...(data as ApplicationRow), ...mem };
        }
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  // Check memory
  const mem = memoryApplications.get(cleanId);
  if (mem) return mem;

  const candidateId = cleanId.includes('_') ? cleanId.split('_')[0] : cleanId;
  for (const app of memoryApplications.values()) {
    if ((app.applywizz_id === cleanId || app.applywizz_id === candidateId) && (!targetJobUrl || app.job_url === targetJobUrl)) {
      return app;
    }
  }

  // 3. Disk fallback (output/resolved_applications.json)
  try {
    const diskPath = path.resolve(process.cwd(), 'output', 'resolved_applications.json');
    if (fs.existsSync(diskPath)) {
      const raw = fs.readFileSync(diskPath, 'utf8');
      const apps = JSON.parse(raw);
      if (Array.isArray(apps)) {
        const found = apps.find((a: any) =>
          (a.applywizzId === cleanId || a.id === cleanId || a.applywizzId === candidateId) && (!targetJobUrl || a.jobUrl === targetJobUrl)
        );
        if (found) {
          const fallbackId: string = found.id || `${found.applywizzId}_${Buffer.from(found.jobUrl || '').toString('base64url').slice(0, 16)}`;
          const converted: ApplicationRow = {
            id: fallbackId,
            applywizz_id: found.applywizzId,
            job_url: found.jobUrl,
            company_name: found.companyName || '',
            job_title: found.jobTitle || '',
            status: found.status || 'READY_FOR_REVIEW',
            resolved_fields: found.resolvedFields || [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          memoryApplications.set(fallbackId, converted);
          return converted;
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Retrieves a candidate application by candidate ID and job URL.
 */
export async function getApplicationByCandidateAndJob(
  applywizzId: string,
  jobUrl: string
): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .eq('job_url', jobUrl)
        .maybeSingle();

      if (!error && data) {
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  for (const app of memoryApplications.values()) {
    if (app.applywizz_id === applywizzId && (app.job_url === jobUrl || jobUrl.includes(app.job_url))) {
      return app;
    }
  }

  return null;
}

/**
 * Updates the resolved fields payload for an application.
 */
export async function updateResolvedFields(
  id: string,
  resolvedFields: any[],
  extra?: { has_manual_edits?: boolean; reviewed_at?: string | null; job_url?: string; applywizz_id?: string }
): Promise<void> {
  const updatePayload: Record<string, any> = {
    resolved_fields: resolvedFields,
    updated_at: new Date().toISOString(),
  };

  if (extra?.has_manual_edits !== undefined) {
    updatePayload.has_manual_edits = extra.has_manual_edits;
  }
  if (extra?.reviewed_at !== undefined) {
    updatePayload.reviewed_at = extra.reviewed_at;
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const mem = memoryApplications.get(id);
  const cleanApplywizz = extra?.applywizz_id || mem?.applywizz_id || (id.includes('_') ? id.split('_')[0] : id);
  const targetJobUrl = extra?.job_url || mem?.job_url;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let updateRes;
      if (isUuid) {
        updateRes = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('id', id);
      } else if (cleanApplywizz && targetJobUrl) {
        updateRes = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', cleanApplywizz)
          .eq('job_url', targetJobUrl);
      } else if (cleanApplywizz) {
        updateRes = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', cleanApplywizz);
      }
      if (updateRes?.error) {
        log.error(`[DB] updateResolvedFields Supabase error (${id}):`, updateRes.error.message);
      }
    } catch (err: any) {
      log.warn(`[DB] updateResolvedFields exception:`, err);
    }
  }

  const existing = memoryApplications.get(id);
  if (existing) {
    memoryApplications.set(id, { ...existing, ...updatePayload });
  }
  for (const [key, app] of memoryApplications.entries()) {
    const jobMatch = !targetJobUrl || app.job_url === targetJobUrl;
    if (app.id === id || ((app.applywizz_id === id || app.applywizz_id === cleanApplywizz) && jobMatch)) {
      memoryApplications.set(key, { ...app, ...updatePayload });
    }
  }
}

export type UpdateStatusExtra =
  | string
  | {
      proof_web_url?: string | null;
      proof_captured_at?: string | null;
      proof_failed_url?: string | null;
      proof_failed_captured_at?: string | null;
      proof_email_url?: string | null;
      proof_email_captured_at?: string | null;
      proof_email_json?: EmailProofJson | null;
      email_proof_status?: EmailProofStatus | null;
      manual_email_review?: boolean;
      email_proof_attempted_at?: string | null;
      dry_run_screenshot_url?: string | null;
      error_message?: string | null;
      job_url?: string | null;
    };

const OPERATOR_WORKLOAD_STATUSES: ApplicationStatus[] = ['READY_FOR_REVIEW', 'APPROVED'];

/**
 * Current review queue depth per operator (`profiles.ca_email`), not date-scoped.
 */
export async function countOperatorWorkloadByProfileCaEmail(
  operatorEmails: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const emails = [...new Set(operatorEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0 || !isSupabaseConfigured()) return counts;

  const emailSet = new Set(emails);
  const { data, error } = await getDbClient()
    .from('candidate_applications')
    .select('id, profiles!inner(ca_email)')
    .in('status', OPERATOR_WORKLOAD_STATUSES);

  if (error) {
    log.warn(`[DB] countOperatorWorkloadByProfileCaEmail failed: ${error.message}`);
    return counts;
  }

  for (const row of data || []) {
    const caEmail = ((row as { profiles?: { ca_email?: string | null } }).profiles?.ca_email || '')
      .trim()
      .toLowerCase();
    if (!caEmail || !emailSet.has(caEmail)) continue;
    counts.set(caEmail, (counts.get(caEmail) || 0) + 1);
  }
  return counts;
}

/**
 * Updates application lifecycle status.
 */
export async function updateStatus(
  id: string,
  status: ApplicationStatus,
  extra?: UpdateStatusExtra
): Promise<boolean> {
  const updatePayload: Partial<ApplicationRow> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (typeof extra === 'string') {
    updatePayload.error_message = normalizeOperatorErrorMessage(extra, status);
  } else if (extra && typeof extra === 'object') {
    if (extra.error_message !== undefined) {
      updatePayload.error_message = normalizeOperatorErrorMessage(extra.error_message, status);
    }
    if (extra.proof_web_url !== undefined) updatePayload.proof_web_url = extra.proof_web_url;
    if (extra.proof_captured_at !== undefined) updatePayload.proof_captured_at = extra.proof_captured_at;
    if (extra.proof_failed_url !== undefined) updatePayload.proof_failed_url = extra.proof_failed_url;
    if (extra.proof_failed_captured_at !== undefined) updatePayload.proof_failed_captured_at = extra.proof_failed_captured_at;
    if (extra.proof_email_url !== undefined) updatePayload.proof_email_url = extra.proof_email_url;
    if (extra.proof_email_json !== undefined) updatePayload.proof_email_json = extra.proof_email_json;
    if (extra.proof_email_captured_at !== undefined) updatePayload.proof_email_captured_at = extra.proof_email_captured_at;
    if (extra.email_proof_status !== undefined) updatePayload.email_proof_status = extra.email_proof_status;
    if (extra.manual_email_review !== undefined) updatePayload.manual_email_review = extra.manual_email_review;
    if (extra.email_proof_attempted_at !== undefined) updatePayload.email_proof_attempted_at = extra.email_proof_attempted_at;
    if (extra.dry_run_screenshot_url !== undefined) updatePayload.dry_run_screenshot_url = extra.dry_run_screenshot_url;
  }

  if (status === 'APPLIED') {
    updatePayload.submitted_at = new Date().toISOString();
  }

  if (statusShouldPersistOperatorError(status) && updatePayload.error_message === undefined) {
    updatePayload.error_message = normalizeOperatorErrorMessage(null, status);
  }

  if (status === 'FAILED' && updatePayload.proof_failed_url && !updatePayload.proof_failed_captured_at) {
    updatePayload.proof_failed_captured_at = new Date().toISOString();
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const mem = memoryApplications.get(id);
  const cleanApplywizz = id.includes('_') ? id.split('_')[0] : id;
  const targetJobUrl = (extra && typeof extra === 'object' && extra.job_url) || mem?.job_url;
  let previousStatus: ApplicationStatus | undefined = mem?.status;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      if (!previousStatus) {
        let statusQuery = supabase.from('candidate_applications').select('status');
        if (isUuid) {
          statusQuery = statusQuery.eq('id', id);
        } else if (targetJobUrl) {
          statusQuery = statusQuery.eq('applywizz_id', cleanApplywizz).eq('job_url', targetJobUrl);
        } else {
          statusQuery = statusQuery.eq('applywizz_id', cleanApplywizz);
        }
        const { data: current } = await statusQuery.order('created_at', { ascending: false }).limit(1).maybeSingle();
        previousStatus = current?.status as ApplicationStatus | undefined;
      }
      const query = supabase.from('candidate_applications').update(updatePayload);
      let updateRes;
      if (isUuid) {
        updateRes = await query.eq('id', id);
      } else if (targetJobUrl) {
        updateRes = await query.eq('applywizz_id', cleanApplywizz).eq('job_url', targetJobUrl);
      } else {
        updateRes = await query.eq('applywizz_id', cleanApplywizz);
      }
      if (updateRes?.error) {
        log.error(`[DB] updateStatus Supabase error (${id}, ${status}):`, updateRes.error.message);
      }
    } catch (err: any) {
      log.warn(`[DB] updateStatus exception:`, err);
    }
  }

  const existing = memoryApplications.get(id);
  if (existing) {
    memoryApplications.set(id, { ...existing, ...updatePayload });
  }
  for (const [key, app] of memoryApplications.entries()) {
    const jobMatch = !targetJobUrl || app.job_url === targetJobUrl;
    if (app.id === id || ((app.applywizz_id === id || app.applywizz_id === cleanApplywizz) && jobMatch)) {
      memoryApplications.set(key, { ...app, ...updatePayload });
    }
  }

  const statusChanged = previousStatus !== status;
  const appLabel = `${cleanApplywizz} ${id}`;
  if (statusChanged) {
    log.info(`[DB] updateStatus ${appLabel}: ${previousStatus || 'UNKNOWN'} → ${status} (status changed, broadcast sent).`);
    const { insertApplicationEvent } = await import('./events.js');
    void insertApplicationEvent({
      applicationId: isUuid ? id : existing?.id || mem?.id || '',
      applywizzId: mem?.applywizz_id || existing?.applywizz_id || (isUuid ? undefined : cleanApplywizz),
      jobUrl: targetJobUrl || null,
      fromStatus: previousStatus || null,
      toStatus: status,
      detail: extra && typeof extra === 'object' && extra.error_message
        ? { error_message: extra.error_message }
        : {},
    });
  } else {
    log.info(`[DB] updateStatus: status unchanged, no broadcast. (${appLabel}: ${status})`);
  }
  return statusChanged;
}

type ApplicationRef = Partial<Pick<ApplicationRow, 'id' | 'applywizz_id' | 'job_url'>>;

function applicationMemoryKey(application: ApplicationRef): string {
  return (
    application.id ||
    (application.applywizz_id && application.job_url
      ? `${application.applywizz_id}_${Buffer.from(application.job_url).toString('base64url').slice(0, 16)}`
      : '')
  );
}

/**
 * Persists a partial application update to Supabase and in-memory cache.
 * Returns true when at least one store was updated.
 */
async function patchApplicationRecord(
  application: ApplicationRef,
  updatePayload: Record<string, unknown>,
  contextLabel: string
): Promise<boolean> {
  let persisted = false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      if (application.id) {
        const { error } = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('id', application.id);
        if (!error) {
          persisted = true;
        } else {
          log.warn(
            `[DB] ⚠️ Could not update DB record (${contextLabel}) for id=${application.id}: ${error.message}`
          );
        }
      }

      if (!persisted && application.applywizz_id && application.job_url) {
        const { error } = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', application.applywizz_id)
          .eq('job_url', application.job_url);
        if (!error) {
          persisted = true;
        } else {
          log.warn(
            `[DB] ⚠️ Could not update DB record (${contextLabel}) for ${application.applywizz_id}: ${error.message}`
          );
        }
      }
    } catch (err: any) {
      log.warn(`[DB] ⚠️ Could not update DB record (${contextLabel}): ${err.message}`);
    }
  }

  const memoryKey = applicationMemoryKey(application);
  const keysToUpdate = new Set<string>();
  if (memoryKey) keysToUpdate.add(memoryKey);
  if (application.id) keysToUpdate.add(application.id);

  for (const key of keysToUpdate) {
    const existing = memoryApplications.get(key);
    if (existing) {
      memoryApplications.set(key, { ...existing, ...updatePayload } as ApplicationRow);
      persisted = true;
    }
  }

  if (!persisted) {
    log.warn(
      `[DB] ⚠️ Could not update DB record (${contextLabel}): no row matched (id=${application.id || 'n/a'}, applywizz_id=${application.applywizz_id || 'n/a'})`
    );
  }

  return persisted;
}

/**
 * Re-signs private bucket proof URLs for API/dashboard consumers (avoids expired signed URLs in <img>).
 */
export async function hydrateApplicationProofUrls(app: ApplicationRow): Promise<ApplicationRow> {
  const storageKey = app.id && isApplicationUuid(app.id) ? app.id : null;
  if (!storageKey || !isSupabaseConfigured()) {
    return app;
  }

  const hydrated = { ...app };

  if (hydrated.proof_web_url) {
    const signed = await getSignedProofUrl(PROOFS_BUCKET, webProofStoragePath(storageKey));
    if (signed) hydrated.proof_web_url = signed;
  }
  if (hydrated.proof_failed_url) {
    const signed = await getSignedProofUrl(PROOFS_FAILED_BUCKET, failedProofStoragePath(storageKey));
    if (signed) hydrated.proof_failed_url = signed;
  }
  if (hydrated.proof_email_url) {
    const signed = await getSignedProofUrl(PROOFS_MAIL_BUCKET, emailProofStoragePath(storageKey));
    if (signed) hydrated.proof_email_url = signed;
  }

  return hydrated;
}

/**
 * Sets the confirmation proof URL and capture timestamp for an application by UUID.
 */
export async function setProofUrl(
  id: string,
  proofUrl: string,
  capturedAt?: string
): Promise<void> {
  await attachProofToApplication({ id }, proofUrl, capturedAt);
}

/**
 * Attaches a post-submission proof screenshot URL to an application record.
 * Resolves by UUID when available, otherwise by (applywizz_id, job_url).
 */
export async function attachProofToApplication(
  application: ApplicationRef,
  proofUrl: string,
  capturedAt?: string
): Promise<boolean> {
  const updatePayload = {
    proof_web_url: proofUrl,
    proof_captured_at: capturedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return patchApplicationRecord(application, updatePayload, 'attachProofToApplication');
}

/**
 * Attaches a failure screenshot URL to an application record.
 */
export async function attachFailedProofToApplication(
  application: ApplicationRef,
  proofFailedUrl: string,
  capturedAt?: string
): Promise<boolean> {
  const updatePayload = {
    proof_failed_url: proofFailedUrl,
    proof_failed_captured_at: capturedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return patchApplicationRecord(application, updatePayload, 'attachFailedProofToApplication');
}

/**
 * Attaches a post-submission confirmation email proof screenshot URL to an application record.
 */
export async function attachEmailProofToApplication(
  application: ApplicationRef,
  proofEmailUrl: string,
  capturedAt?: string
): Promise<boolean> {
  const updatePayload = {
    proof_email_url: proofEmailUrl,
    proof_email_captured_at: capturedAt || new Date().toISOString(),
    email_proof_status: 'captured' as EmailProofStatus,
    updated_at: new Date().toISOString(),
  };
  return patchApplicationRecord(application, updatePayload, 'attachEmailProofToApplication');
}

/**
 * Attaches parsed confirmation email content (JSON) — primary email proof (no screenshot).
 */
export async function attachEmailProofJsonToApplication(
  application: ApplicationRef,
  proofEmailJson: EmailProofJson,
  capturedAt?: string
): Promise<boolean> {
  const updatePayload = {
    proof_email_json: proofEmailJson,
    proof_email_captured_at: capturedAt || proofEmailJson.received_at || new Date().toISOString(),
    email_proof_status: 'captured' as EmailProofStatus,
    updated_at: new Date().toISOString(),
  };
  return patchApplicationRecord(application, updatePayload, 'attachEmailProofJsonToApplication');
}

/**
 * Updates the email proof lifecycle status (e.g. 'pending', 'captured', 'timed_out').
 */
export async function updateEmailProofStatus(
  application: ApplicationRef,
  status: EmailProofStatus,
  extra?: { attemptedAt?: string }
): Promise<boolean> {
  const updatePayload: Record<string, any> = {
    email_proof_status: status,
    updated_at: new Date().toISOString(),
  };

  if (status === 'pending') {
    updatePayload.email_proof_attempted_at = extra?.attemptedAt || new Date().toISOString();
  }

  return patchApplicationRecord(application, updatePayload, 'updateEmailProofStatus');
}

/**
 * Sets the dry-run screenshot URL for an application.
 * Resolves by UUID when available, otherwise by (applywizz_id, job_url) or applywizz_id.
 */
export async function setDryRunScreenshotUrl(
  applicationOrId: string | ApplicationRef,
  screenshotUrl: string
): Promise<boolean> {
  const updatePayload = {
    dry_run_screenshot_url: screenshotUrl,
    updated_at: new Date().toISOString(),
  };

  const appRef: ApplicationRef =
    typeof applicationOrId === 'string'
      ? isApplicationUuid(applicationOrId)
        ? { id: applicationOrId }
        : { applywizz_id: applicationOrId.includes('_') ? applicationOrId.split('_')[0] : applicationOrId }
      : applicationOrId;

  return patchApplicationRecord(appRef, updatePayload, 'setDryRunScreenshotUrl');
}

/**
 * Sets the failure screenshot URL for an application by UUID (symmetry with setDryRunScreenshotUrl).
 */
export async function setFailedScreenshotUrl(
  id: string,
  screenshotUrl: string,
  capturedAt?: string
): Promise<void> {
  await attachFailedProofToApplication({ id }, screenshotUrl, capturedAt);
}

export interface ApplicationDto {
  id?: string;
  applywizz_id: string;
  applywizzId: string;
  job_url: string;
  jobUrl: string;
  company_name: string | null;
  companyName: string | null;
  job_title: string | null;
  jobTitle: string | null;
  candidate_name?: string | null;
  candidateName?: string | null;
  status: ApplicationStatus;
  resolved_fields: any[];
  resolvedFields: any[];
  proof_web_url: string | null;
  proofWebUrl: string | null;
  proof_captured_at: string | null;
  proofCapturedAt: string | null;
  proof_email_url: string | null;
  proofEmailUrl: string | null;
  proof_email_json: EmailProofJson | null;
  proofEmailJson: EmailProofJson | null;
  proof_email_captured_at: string | null;
  proofEmailCapturedAt: string | null;
  email_proof_status: EmailProofStatus | null;
  emailProofStatus: EmailProofStatus | null;
  email_proof_attempted_at: string | null;
  emailProofAttemptedAt: string | null;
  proof_failed_url: string | null;
  proofFailedUrl: string | null;
  proof_failed_captured_at: string | null;
  proofFailedCapturedAt: string | null;
  dry_run_screenshot_url: string | null;
  dryRunScreenshotUrl: string | null;
  error_message: string | null;
  errorMessage: string | null;
  has_manual_edits: boolean;
  hasManualEdits: boolean;
  reviewed_at: string | null;
  reviewedAt: string | null;
  submitted_at: string | null;
  submittedAt: string | null;
  submission_order?: number | null;
  submissionOrder?: number | null;
  assigned_ca_email?: string | null;
  assignedCaEmail?: string | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  retry_count?: number | null;
  retryCount?: number | null;
}

/**
 * When resolved_fields is empty, copies fields_schema from scanned_job_templates and persists the snapshot.
 */
export async function hydrateAndPersistApplicationFields(app: ApplicationRow): Promise<ApplicationRow> {
  const { application, hydratedFromTemplate } = await hydrateApplicationResolvedFields(app);
  if (!hydratedFromTemplate) {
    return application;
  }
  return upsertApplication({
    id: application.id,
    applywizz_id: application.applywizz_id,
    job_url: application.job_url,
    company_name: application.company_name,
    job_title: application.job_title,
    status: application.status,
    resolved_fields: application.resolved_fields,
  });
}

/**
 * Shared serializer mapping database/in-memory application objects to a complete API DTO.
 * Ensures strict parity with both snake_case and camelCase fields for web, email, failure, and dry-run proofs.
 */
export function serializeApplicationDto(
  app: any,
  overrides?: Record<string, any>
): ApplicationDto {
  const merged = { ...(app || {}), ...(overrides || {}) };

  const applywizzId = merged.applywizz_id || merged.applywizzId || '';
  const jobUrl = merged.job_url || merged.jobUrl || '';
  const companyName = merged.company_name || merged.companyName || null;
  const jobTitle = merged.job_title || merged.jobTitle || null;
  const candidateName = merged.candidate_name || merged.candidateName || null;
  const status = (merged.status || 'READY_FOR_REVIEW') as ApplicationStatus;
  const resolvedFields = Array.isArray(merged.resolved_fields)
    ? merged.resolved_fields
    : Array.isArray(merged.resolvedFields)
    ? merged.resolvedFields
    : [];

  const proofWebUrl = merged.proof_web_url || merged.proofWebUrl || null;
  const proofCapturedAt = merged.proof_captured_at || merged.proofCapturedAt || null;
  const proofEmailUrl = merged.proof_email_url || merged.proofEmailUrl || null;
  const proofEmailJson = (merged.proof_email_json || merged.proofEmailJson || null) as EmailProofJson | null;
  const proofEmailCapturedAt = merged.proof_email_captured_at || merged.proofEmailCapturedAt || null;
  const emailProofStatus = (merged.email_proof_status || merged.emailProofStatus || null) as EmailProofStatus | null;
  const emailProofAttemptedAt = merged.email_proof_attempted_at || merged.emailProofAttemptedAt || null;
  const proofFailedUrl = merged.proof_failed_url || merged.proofFailedUrl || null;
  const proofFailedCapturedAt = merged.proof_failed_captured_at || merged.proofFailedCapturedAt || null;
  const dryRunScreenshotUrl = merged.dry_run_screenshot_url || merged.dryRunScreenshotUrl || merged.screenshotUrl || null;
  const rawErrorMessage = merged.error_message || merged.errorMessage || null;
  const errorMessage =
    rawErrorMessage || statusShouldPersistOperatorError(status)
      ? normalizeOperatorErrorMessage(rawErrorMessage, status)
      : null;
  const hasManualEdits = Boolean(merged.has_manual_edits ?? merged.hasManualEdits ?? false);
  const reviewedAt = merged.reviewed_at || merged.reviewedAt || null;
  const submittedAt = merged.submitted_at || merged.submittedAt || null;
  const submissionOrder = merged.submission_order ?? merged.submissionOrder ?? null;
  const assignedCaEmail = merged.assigned_ca_email || merged.assignedCaEmail || null;
  const createdAt = merged.created_at || merged.createdAt;
  const updatedAt = merged.updated_at || merged.updatedAt;
  const retryCount = Number(merged.retry_count ?? merged.retryCount ?? 0);

  return {
    id: merged.id,
    applywizz_id: applywizzId,
    applywizzId,
    job_url: jobUrl,
    jobUrl,
    company_name: companyName,
    companyName,
    job_title: jobTitle,
    jobTitle,
    candidate_name: candidateName,
    candidateName,
    status,
    resolved_fields: resolvedFields,
    resolvedFields,
    proof_web_url: proofWebUrl,
    proofWebUrl,
    proof_captured_at: proofCapturedAt,
    proofCapturedAt,
    proof_email_url: proofEmailUrl,
    proofEmailUrl,
    proof_email_json: proofEmailJson,
    proofEmailJson,
    proof_email_captured_at: proofEmailCapturedAt,
    proofEmailCapturedAt,
    email_proof_status: emailProofStatus,
    emailProofStatus,
    email_proof_attempted_at: emailProofAttemptedAt,
    emailProofAttemptedAt,
    proof_failed_url: proofFailedUrl,
    proofFailedUrl,
    proof_failed_captured_at: proofFailedCapturedAt,
    proofFailedCapturedAt,
    dry_run_screenshot_url: dryRunScreenshotUrl,
    dryRunScreenshotUrl,
    error_message: errorMessage,
    errorMessage,
    has_manual_edits: hasManualEdits,
    hasManualEdits,
    reviewed_at: reviewedAt,
    reviewedAt,
    submitted_at: submittedAt,
    submittedAt,
    submission_order: submissionOrder,
    submissionOrder,
    assigned_ca_email: assignedCaEmail,
    assignedCaEmail,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
    retry_count: Number.isFinite(retryCount) ? retryCount : 0,
    retryCount: Number.isFinite(retryCount) ? retryCount : 0,
  };
}

export const MAX_SUBMISSION_RETRIES = 3;

export async function retryFailedApplication(
  application: ApplicationRow
): Promise<boolean> {
  const payload = {
    status: 'QUEUED' as const,
    retry_count: 0,
    error_message: null,
    submission_order: Date.now(),
    updated_at: new Date().toISOString(),
  };
  let updated = false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase.from('candidate_applications').update(payload);
      if (application.id) {
        query = query.eq('id', application.id);
      } else {
        query = query
          .eq('applywizz_id', application.applywizz_id)
          .eq('job_url', application.job_url);
      }
      const result = await query.eq('status', 'FAILED').select('id');
      updated = !result.error && Array.isArray(result.data) && result.data.length > 0;
      if (result.error) {
        log.warn(`[DB] Operator retry failed for ${application.id || application.applywizz_id}: ${result.error.message}`);
      }
    } catch (err: any) {
      log.warn(`[DB] Operator retry exception for ${application.id || application.applywizz_id}: ${err.message}`);
    }
  } else {
    updated = true;
  }

  if (!updated) return false;
  cacheApplicationLocally({ ...application, ...payload });
  return true;
}

export async function requeueApplicationForRetry(
  applicationId: string,
  reason: string,
  jobUrl?: string
): Promise<{ requeued: boolean; retryCount: number }> {
  const app = await getApplication(applicationId, jobUrl);
  if (!app) return { requeued: false, retryCount: 0 };
  const currentRetryCount = app.retry_count ?? 0;
  if (currentRetryCount >= MAX_SUBMISSION_RETRIES) {
    return { requeued: false, retryCount: currentRetryCount };
  }

  const nextRetryCount = currentRetryCount + 1;
  const nextOrder = Date.now();
  const payload = {
    status: 'QUEUED' as const,
    retry_count: nextRetryCount,
    submission_order: nextOrder,
    error_message: reason,
    updated_at: new Date().toISOString(),
  };
  let updated = false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase.from('candidate_applications').update(payload);
      if (app.id) {
        query = query.eq('id', app.id);
      } else {
        query = query.eq('applywizz_id', app.applywizz_id).eq('job_url', app.job_url);
      }
      const result = await query
        .eq('status', 'FAILED')
        .eq('retry_count', currentRetryCount)
        .select('id');
      updated = !result.error && Array.isArray(result.data) && result.data.length > 0;
      if (result.error) log.warn(`[DB] Retry requeue failed for ${applicationId}: ${result.error.message}`);
    } catch (err: any) {
      log.warn(`[DB] Retry requeue exception for ${applicationId}: ${err.message}`);
    }
  } else {
    updated = true;
  }

  if (!updated) return { requeued: false, retryCount: currentRetryCount };
  cacheApplicationLocally({ ...app, ...payload });
  log.info(`[Queue] Retry ${nextRetryCount}/${MAX_SUBMISSION_RETRIES} → QUEUED (${applicationId}): ${reason}`);
  return { requeued: true, retryCount: nextRetryCount };
}


/**
 * Counts terminal submission outcomes (APPLIED / FAILED), deduped by candidate + job URL,
 * optionally filtered by IST calendar date and allowed candidate IDs.
 */
export async function getSubmissionOutcomeCounts(options?: {
  date?: string;
  createdAtRange?: CreatedAtRangeFilter;
  allowedCandidateIds?: string[];
}): Promise<{
  successfulApplications: number;
  failedApplications: number;
}> {
  const allowedSet = options?.allowedCandidateIds && options.allowedCandidateIds.length > 0
    ? new Set(options.allowedCandidateIds.map((id) => id.toUpperCase()))
    : null;

  const legacyDay =
    options?.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date) ? getISTDateRangeUtc(options.date) : null;
  const createdAtRange =
    options?.createdAtRange ??
    (legacyDay ? { startIso: legacyDay.startIso, endIso: legacyDay.endIso } : null);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let appliedQuery = supabase
        .from('candidate_applications')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'APPLIED');

      let failedQuery = supabase
        .from('candidate_applications')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'FAILED');

      if (allowedSet && options?.allowedCandidateIds) {
        appliedQuery = appliedQuery.in('applywizz_id', options.allowedCandidateIds);
        failedQuery = failedQuery.in('applywizz_id', options.allowedCandidateIds);
      }

      if (createdAtRange) {
        appliedQuery = applyCreatedAtRangeFilter(appliedQuery, createdAtRange);
        failedQuery = applyCreatedAtRangeFilter(failedQuery, createdAtRange);
      }

      const [appliedRes, failedRes] = await Promise.all([appliedQuery, failedQuery]);
      if (!appliedRes.error && !failedRes.error) {
        return {
          successfulApplications: appliedRes.count ?? 0,
          failedApplications: failedRes.count ?? 0,
        };
      }
    } catch {
      // Fall through to in-memory counts
    }
  }

  const seen = new Set<string>();
  let successfulApplications = 0;
  let failedApplications = 0;
  for (const row of memoryApplications.values()) {
    if (allowedSet && !allowedSet.has(row.applywizz_id.toUpperCase())) {
      continue;
    }

    if (createdAtRange && !rowCreatedAtInRange(row, createdAtRange)) {
      continue;
    }

    const key = `${row.applywizz_id}::${row.job_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.status === 'APPLIED') successfulApplications++;
    else if (row.status === 'FAILED') failedApplications++;
  }
  return { successfulApplications, failedApplications };
}

export async function getDashboardApplicationMetrics(options?: {
  createdAtRange?: CreatedAtRangeFilter;
  allowedCandidateIds?: string[];
}): Promise<{
  totalApplications: number;
  totalCandidates: number;
  uniqueScannedJobs: number;
  totalFieldsPopulated: number;
  supabaseTaggedCount: number;
  aiTaggedCount: number;
}> {
  const allowedSet =
    options?.allowedCandidateIds && options.allowedCandidateIds.length > 0
      ? new Set(options.allowedCandidateIds.map((id) => id.toUpperCase()))
      : null;
  const range = options?.createdAtRange;

  let totalApplications = 0;
  let totalFieldsPopulated = 0;
  let supabaseTaggedCount = 0;
  let aiTaggedCount = 0;
  const candidateIds = new Set<string>();
  const jobUrls = new Set<string>();

  const tallyRow = (row: ApplicationRow) => {
    if (allowedSet && !allowedSet.has(row.applywizz_id.toUpperCase())) return;
    if (range && !rowCreatedAtInRange(row, range)) return;
    if (row.status === 'SKIPPED') return;
    totalApplications += 1;
    candidateIds.add(row.applywizz_id.toUpperCase());
    if (row.job_url) jobUrls.add(row.job_url);
    const fields = Array.isArray(row.resolved_fields) ? row.resolved_fields : [];
    for (const f of fields) {
      totalFieldsPopulated += 1;
      if (f?.source === 'supabase') supabaseTaggedCount += 1;
      if (f?.source === 'ai') aiTaggedCount += 1;
    }
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('candidate_applications')
        .select('applywizz_id, job_url, status, resolved_fields, created_at');
      if (allowedSet && options?.allowedCandidateIds) {
        query = query.in('applywizz_id', options.allowedCandidateIds);
      }
      if (range) {
        query = applyCreatedAtRangeFilter(query, range);
      }
      const { data, error } = await query;
      if (!error && data) {
        for (const row of data as ApplicationRow[]) {
          tallyRow(row);
        }
        return {
          totalApplications,
          totalCandidates: candidateIds.size,
          uniqueScannedJobs: jobUrls.size,
          totalFieldsPopulated,
          supabaseTaggedCount,
          aiTaggedCount,
        };
      }
    } catch {
      // fall through
    }
  }

  for (const row of memoryApplications.values()) {
    tallyRow(row);
  }

  return {
    totalApplications,
    totalCandidates: candidateIds.size,
    uniqueScannedJobs: jobUrls.size,
    totalFieldsPopulated,
    supabaseTaggedCount,
    aiTaggedCount,
  };
}

/** Distinct applywizz IDs with non-SKIPPED applications in the dashboard date range (dev/admin list hydration). */
export async function distinctApplywizzIdsForCreatedAtRange(
  createdAtRange: CreatedAtRangeFilter
): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    let query = getDbClient()
      .from('candidate_applications')
      .select('applywizz_id, status, created_at')
      .neq('status', 'SKIPPED');
    query = applyCreatedAtRangeFilter(query, createdAtRange);
    const { data, error } = await query;
    if (error) {
      log.warn(`[Applications] distinctApplywizzIdsForCreatedAtRange failed: ${error.message}`);
      return [];
    }
    const ids = new Set<string>();
    for (const row of (data || []) as ApplicationRow[]) {
      if (!rowCreatedAtInRange(row, createdAtRange)) continue;
      if (row.status === 'SKIPPED') continue;
      const id = String(row.applywizz_id || '').trim().toUpperCase();
      if (id) ids.add(id);
    }
    return Array.from(ids);
  } catch (err: any) {
    log.warn(`[Applications] distinctApplywizzIdsForCreatedAtRange exception: ${err?.message || err}`);
    return [];
  }
}

/**
 * Lists candidate applications with optional status and candidate filters.
 */
export async function listApplications(filter?: {
  status?: ApplicationStatus;
  applywizzId?: string;
}): Promise<ApplicationRow[]> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const buildQuery = () => {
        let q = supabase.from('candidate_applications').select('*');
        if (filter?.status) {
          q = q.eq('status', filter.status);
        }
        if (filter?.applywizzId) {
          q = q.eq('applywizz_id', filter.applywizzId);
        }
        return q;
      };

      // Try ordering by has_manual_edits and reviewed_at first
      let { data, error } = await buildQuery()
        .order('has_manual_edits', { ascending: true })
        .order('reviewed_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });

      // If columns don't exist yet on remote schema, fall back to created_at
      if (error && (error.message?.includes('has_manual_edits') || error.code === '42703')) {
        const fallback = await buildQuery().order('created_at', { ascending: false });
        data = fallback.data;
        error = fallback.error;
      }

      if (!error && data) {
        return data as ApplicationRow[];
      }
    } catch (err: any) {
      // Fall through
    }
  }

  let results = Array.from(memoryApplications.values());
  if (filter?.status) {
    results = results.filter((a) => a.status === filter.status);
  }
  if (filter?.applywizzId) {
    results = results.filter((a) => a.applywizz_id === filter.applywizzId);
  }

  results.sort((a, b) => {
    const aEdited = a.has_manual_edits ? 1 : 0;
    const bEdited = b.has_manual_edits ? 1 : 0;
    if (aEdited !== bEdited) return aEdited - bEdited;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  return results;
}

export type CandidateQueueStatus =
  | 'NO_APPLICATIONS'
  | 'READY'
  | 'IN_PROGRESS'
  | 'DONE';

const QUEUE_STATUS_IN_PROGRESS: ReadonlySet<ApplicationStatus> = new Set([
  'APPROVED',
  'QUEUED',
  'APPLYING',
]);

const QUEUE_STATUS_DONE: ReadonlySet<ApplicationStatus> = new Set([
  'APPLIED',
  'FAILED',
  'EXPIRED',
  'OTP_REQUIRED',
  'CAPTCHA_TIMEOUT',
  'CAPTCHA_REQUIRED',
  'EMAIL_PROOF_PENDING',
  'EMAIL_UNVERIFIED',
  'SKIPPED',
]);

/**
 * Derives dashboard queue_status for one candidate from all candidate_applications statuses.
 * Priority when mixed: IN_PROGRESS > READY > DONE > NO_APPLICATIONS.
 */
export function deriveCandidateQueueStatus(
  statuses: ApplicationStatus[]
): CandidateQueueStatus {
  if (statuses.length === 0) {
    return 'NO_APPLICATIONS';
  }
  if (statuses.some((s) => QUEUE_STATUS_IN_PROGRESS.has(s))) {
    return 'IN_PROGRESS';
  }
  if (statuses.some((s) => s === 'READY_FOR_REVIEW')) {
    return 'READY';
  }
  if (statuses.every((s) => QUEUE_STATUS_DONE.has(s))) {
    return 'DONE';
  }
  return 'READY';
}

export interface CandidateApplicationAggregate {
  job_count: number;
  queue_status: CandidateQueueStatus;
}

export type CandidateApplicationAggregateRow = {
  applywizz_id: string;
  status: ApplicationStatus;
  assigned_ca_email?: string | null;
  resolved_fields?: unknown;
  created_at?: string;
};

/**
 * job_count = COUNT(*) of candidate_applications rows per applywizz_id (all statuses).
 * Optional scope matches dashboard GET .../jobs (created_at range + per-row includeRow).
 */
export async function fetchCandidateApplicationAggregatesByApplywizzIds(
  applywizzIds: string[],
  options?: {
    createdAtRange?: CreatedAtRangeFilter;
    includeRow?: (row: CandidateApplicationAggregateRow) => boolean;
  }
): Promise<Map<string, CandidateApplicationAggregate>> {
  const aggregates = new Map<string, CandidateApplicationAggregate>();
  const ids = [...new Set(applywizzIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return aggregates;
  }

  const statusesByKey = new Map<string, ApplicationStatus[]>();
  let loadedFromSupabase = false;
  const scoped = Boolean(options?.createdAtRange || options?.includeRow);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('candidate_applications')
        .select(
          scoped
            ? 'applywizz_id, status, assigned_ca_email, resolved_fields, created_at'
            : 'applywizz_id, status'
        )
        .in('applywizz_id', ids);
      if (options?.createdAtRange) {
        query = applyCreatedAtRangeFilter(query, options.createdAtRange);
      }
      const { data, error } = await query;
      if (!error && data) {
        loadedFromSupabase = true;
        for (const row of data) {
          const aggregateRow = row as unknown as CandidateApplicationAggregateRow;
          if (options?.includeRow && !options.includeRow(aggregateRow)) continue;
          const key = String(aggregateRow.applywizz_id || '').trim().toUpperCase();
          if (!key) continue;
          const list = statusesByKey.get(key) || [];
          list.push(aggregateRow.status as ApplicationStatus);
          statusesByKey.set(key, list);
        }
      }
    } catch {
      // fall through to memory
    }
  }

  if (!loadedFromSupabase) {
    for (const app of memoryApplications.values()) {
      const key = app.applywizz_id.trim().toUpperCase();
      if (!ids.some((id) => id.toUpperCase() === key)) continue;
      const aggregateRow: CandidateApplicationAggregateRow = {
        applywizz_id: app.applywizz_id,
        status: app.status,
        assigned_ca_email: app.assigned_ca_email,
        resolved_fields: app.resolved_fields,
        created_at: app.created_at,
      };
      if (options?.createdAtRange && !rowCreatedAtInRange(app, options.createdAtRange)) continue;
      if (options?.includeRow && !options.includeRow(aggregateRow)) continue;
      const list = statusesByKey.get(key) || [];
      list.push(app.status);
      statusesByKey.set(key, list);
    }
  }

  for (const id of ids) {
    const key = id.toUpperCase();
    const statuses = statusesByKey.get(key) || [];
    aggregates.set(key, {
      job_count: statuses.length,
      queue_status: deriveCandidateQueueStatus(statuses),
    });
  }

  return aggregates;
}

/**
 * Count candidate_applications per applywizz_id, excluding SKIPPED and unresolved placeholders (dashboard queue size).
 */
export async function countNonSkippedApplicationsByApplywizzIds(
  applywizzIds: string[],
  createdAtRange?: CreatedAtRangeFilter
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = [...new Set(applywizzIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return counts;
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('candidate_applications')
        .select('applywizz_id, status, resolved_fields, created_at')
        .in('applywizz_id', ids);
      if (createdAtRange) {
        query = applyCreatedAtRangeFilter(query, createdAtRange);
      }
      const { data, error } = await query;
      if (!error && data) {
        for (const row of data) {
          if (row.status === 'SKIPPED') continue;
          if (!applicationRowHasPersistedResolution(row)) continue;
          const key = String(row.applywizz_id || '').trim().toUpperCase();
          if (!key) continue;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return counts;
      }
    } catch {
      // fall through
    }
  }

  for (const app of memoryApplications.values()) {
    if (app.status === 'SKIPPED') continue;
    if (!applicationRowHasPersistedResolution(app)) continue;
    if (createdAtRange && !rowCreatedAtInRange(app, createdAtRange)) continue;
    const key = app.applywizz_id.trim().toUpperCase();
    if (!ids.some((id) => id.toUpperCase() === key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** Count applications in a given status (Supabase head count, memory fallback). */
export async function countApplicationsByStatus(status: ApplicationStatus): Promise<number> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { count, error } = await supabase
        .from('candidate_applications')
        .select('*', { count: 'exact', head: true })
        .eq('status', status);
      if (!error && typeof count === 'number') {
        return count;
      }
    } catch {
      // fall through
    }
  }
  return Array.from(memoryApplications.values()).filter((a) => a.status === status).length;
}

/**
 * Event-based queue status logger:
 * [Queue] Status change: <FROM> → <TO> (app-<id>) | <queued> total queued, <applying> applying
 */
export async function logQueueStatusChange(
  appRef: string,
  fromStatus: string,
  toStatus: string
): Promise<void> {
  const queuedCount = await countApplicationsByStatus('QUEUED');
  const applyingCount = await countApplicationsByStatus('APPLYING');
  log.info(
    `[Queue] Status change: ${fromStatus} → ${toStatus} (app-${appRef}) | ${queuedCount} total queued, ${applyingCount} applying`
  );
}

/**
 * Inserts or transitions an application into the global submission queue (Phase V2-4c).
 * Calculates submission_order = MAX(submission_order) + 1 across all active/submitted applications.
 */
export async function enqueueApplication(
  applicationIdOrApplywizzId: string,
  options: { assignedCaEmail?: string; jobUrl?: string } = {}
): Promise<{ submissionOrder: number; application: ApplicationRow }> {
  const app = await getApplication(applicationIdOrApplywizzId, options.jobUrl);
  if (!app) {
    throw new Error(`Application '${applicationIdOrApplywizzId}' not found to queue.`);
  }

  assertEligibleForSubmission(app);

  const previousStatus = app.status || 'READY_FOR_REVIEW';

  // 1. Calculate next global submission_order
  let maxOrder = 0;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .select('submission_order')
        .in('status', ['QUEUED', 'APPLYING', 'APPLIED', 'FAILED'])
        .not('submission_order', 'is', null)
        .order('submission_order', { ascending: false })
        .limit(1);

      if (!error && data && data.length > 0 && typeof data[0].submission_order === 'number') {
        maxOrder = data[0].submission_order;
      }
    } catch (err: any) {
      log.warn(`[DB] Error querying MAX(submission_order): ${err.message}`);
    }
  }

  // Memory fallback check for MAX order
  for (const a of memoryApplications.values()) {
    if (
      ['QUEUED', 'APPLYING', 'APPLIED', 'FAILED'].includes(a.status) &&
      typeof a.submission_order === 'number' &&
      a.submission_order > maxOrder
    ) {
      maxOrder = a.submission_order;
    }
  }

  const nextOrder = maxOrder + 1;
  const updatePayload: Partial<ApplicationRow> = {
    status: 'QUEUED',
    submission_order: nextOrder,
    assigned_ca_email: options.assignedCaEmail || app.assigned_ca_email || null,
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(app.id || '');
      let queueRes;
      if (isUuid) {
        queueRes = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('id', app.id);
      } else {
        queueRes = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', app.applywizz_id)
          .eq('job_url', app.job_url);
      }
      if (queueRes?.error) {
        log.error(`[DB] enqueueApplication Supabase error:`, queueRes.error.message);
      }
    } catch (err: any) {
      log.warn(`[DB] Could not update application to QUEUED in Supabase: ${err.message}`);
    }
  }

  const updatedApp: ApplicationRow = {
    ...app,
    ...updatePayload,
  };

  cacheApplicationLocally(updatedApp);
  const resolvedId = updatedApp.id || applicationIdOrApplywizzId;
  log.info(`[API] Submit clicked → status = QUEUED (ready for queue daemon)`);
  log.info(`[API] Status → QUEUED (application ${resolvedId}, submission_order=${nextOrder})`);
  await logQueueStatusChange(resolvedId, previousStatus, 'QUEUED');
  if (process.env.ENABLE_QUEUE_WORKER !== 'true') {
    log.warn(
      `[Queue] ENABLE_QUEUE_WORKER is not "true" — app ${resolvedId} will remain QUEUED until a submission worker runs`
    );
  }
  return { submissionOrder: nextOrder, application: updatedApp };
}

/**
 * Retrieves the next application in the global submission queue for round-robin processing (Phase V2-4c).
 * Uses atomic PostgreSQL FOR UPDATE SKIP LOCKED via RPC with fallback to query.
 * Transitions status to 'APPLYING'.
 */
export async function getNextQueuedApplicationForRoundRobin(): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    const supabase = getDbClient();

    // 1. Try atomic PostgreSQL RPC function first
    try {
      const { data, error } = await supabase.rpc('get_next_queued_application');
      if (!error && data && Array.isArray(data) && data.length > 0) {
        const selected = data[0] as ApplicationRow;
        cacheApplicationLocally(selected);
        const appRef = selected.id || selected.applywizz_id;
        log.info(`[API] Status → APPLYING (application ${appRef}, dequeued via RPC from QUEUED)`);
        return selected;
      }
    } catch (rpcErr: any) {
      // If RPC doesn't exist or errors, fall through to fallback query
    }

    // 2. Fallback query if RPC is not yet created in Supabase SQL editor
    try {
      const { data, error } = await supabase
        .from('candidate_applications')
        .select('*')
        .eq('status', 'QUEUED')
        .order('submission_order', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        const updateRes = await supabase
          .from('candidate_applications')
          .update({
            status: 'APPLYING',
            updated_at: new Date().toISOString(),
          })
          .eq('id', data.id)
          .eq('status', 'QUEUED'); // concurrency optimistic lock

        if (!updateRes.error) {
          const applyingApp: ApplicationRow = {
            ...(data as ApplicationRow),
            status: 'APPLYING',
            updated_at: new Date().toISOString(),
          };
          cacheApplicationLocally(applyingApp);
          const appRef = applyingApp.id || applyingApp.applywizz_id;
          log.info(`[API] Status → APPLYING (application ${appRef}, dequeued from QUEUED)`);
          return applyingApp;
        }
      }
    } catch (queryErr: any) {
      log.warn(`[DB] Fallback queue selection error: ${queryErr.message}`);
    }
  }

  // 3. In-memory queue selection fallback
  const queued = Array.from(memoryApplications.values())
    .filter((a) => a.status === 'QUEUED')
    .sort((a, b) => (a.submission_order || 0) - (b.submission_order || 0));

  if (queued.length > 0) {
    const next = queued[0];
    next.status = 'APPLYING';
    next.updated_at = new Date().toISOString();
    const appRef = next.id || next.applywizz_id;
    log.info(`[API] Status → APPLYING (application ${appRef}, dequeued from in-memory QUEUED)`);
    return next;
  }

  return null;
}

export interface NotificationItem {
  id: string;
  applywizzId: string;
  candidateName?: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  status: 'APPLYING' | 'APPLIED' | 'FAILED';
  reason?: string | null;
  proofWebUrl?: string | null;
  proofFailedUrl?: string | null;
  timestamp: string;
}

const DISMISSED_NOTIFS_PATH = path.resolve(process.cwd(), 'cache', 'dismissed_notifications.json');

function loadDismissedNotificationIds(): Set<string> {
  const set = new Set<string>();
  try {
    if (fs.existsSync(DISMISSED_NOTIFS_PATH)) {
      const data = JSON.parse(fs.readFileSync(DISMISSED_NOTIFS_PATH, 'utf-8'));
      if (Array.isArray(data)) {
        for (const id of data) set.add(id);
      }
    }
  } catch {}
  return set;
}

function saveDismissedNotificationIds(set: Set<string>): void {
  try {
    const dir = path.dirname(DISMISSED_NOTIFS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISMISSED_NOTIFS_PATH, JSON.stringify(Array.from(set)), 'utf-8');
  } catch {}
}

const dismissedNotificationIds = loadDismissedNotificationIds();

/**
 * Dismisses a notification by ID so it no longer appears in GET /api/notifications.
 */
export function dismissNotification(id: string): boolean {
  if (!id) return false;
  dismissedNotificationIds.add(id);
  saveDismissedNotificationIds(dismissedNotificationIds);
  return true;
}

/**
 * Dismisses all given notification IDs (or all current active).
 */
export function dismissAllNotifications(ids?: string[]): void {
  if (ids && ids.length > 0) {
    for (const id of ids) dismissedNotificationIds.add(id);
  }
  saveDismissedNotificationIds(dismissedNotificationIds);
}

function resolveCandidateName(applywizzId: string): string {
  try {
    const profileFile = path.resolve(process.cwd(), 'cache', 'profiles', `${applywizzId}.json`);
    if (fs.existsSync(profileFile)) {
      const data = JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
      if (data.clientName || data.client_name) {
        return data.clientName || data.client_name;
      }
    }
  } catch {}
  return applywizzId;
}

/**
 * Fetches recent real application events (APPLYING, APPLIED, FAILED),
 * optionally filtered by IST calendar date and assigned candidate IDs.
 */
export async function getRecentNotifications(
  limit = 50,
  filter?: { date?: string; createdAtRange?: CreatedAtRangeFilter; allowedCandidateIds?: string[] }
): Promise<NotificationItem[]> {
  const notifications: NotificationItem[] = [];

  const allowedSet = filter?.allowedCandidateIds && filter.allowedCandidateIds.length > 0
    ? new Set(filter.allowedCandidateIds.map((id) => id.toUpperCase()))
    : null;

  const legacyDay =
    filter?.date && /^\d{4}-\d{2}-\d{2}$/.test(filter.date) ? getISTDateRangeUtc(filter.date) : null;
  const createdAtRange =
    filter?.createdAtRange ??
    (legacyDay ? { startIso: legacyDay.startIso, endIso: legacyDay.endIso } : null);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('candidate_applications')
        .select('id, applywizz_id, job_url, company_name, job_title, status, error_message, proof_web_url, proof_failed_url, updated_at, submitted_at, created_at')
        .in('status', ['APPLYING', 'APPLIED', 'FAILED'])
        .neq('applywizz_id', 'AWL-YASWANTH');

      if (allowedSet && filter?.allowedCandidateIds) {
        query = query.in('applywizz_id', filter.allowedCandidateIds);
      }

      if (createdAtRange) {
        query = applyCreatedAtRangeFilter(query, createdAtRange);
      }

      const { data, error } = await query
        .order('updated_at', { ascending: false })
        .limit(limit * 2);

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const id = row.id || `notif-${row.applywizz_id}-${Buffer.from(row.job_url || '').toString('base64url').slice(0, 16)}`;
          if (dismissedNotificationIds.has(id) || (row.id && dismissedNotificationIds.has(row.id))) {
            continue;
          }

          notifications.push({
            id,
            applywizzId: row.applywizz_id,
            candidateName: resolveCandidateName(row.applywizz_id),
            companyName: row.company_name || 'Greenhouse Company',
            jobTitle: row.job_title || 'Job Opening',
            jobUrl: row.job_url,
            status: row.status as 'APPLYING' | 'APPLIED' | 'FAILED',
            reason: row.error_message || null,
            proofWebUrl: row.proof_web_url || null,
            proofFailedUrl: row.proof_failed_url || null,
            timestamp: row.updated_at || row.submitted_at || new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      log.warn(`[DB] getRecentNotifications Supabase warning: ${err.message}`);
    }
  }

  // Incorporate in-memory applications
  for (const app of memoryApplications.values()) {
    if (
      (app.status === 'APPLYING' || app.status === 'APPLIED' || app.status === 'FAILED') &&
      app.applywizz_id !== 'AWL-YASWANTH'
    ) {
      if (allowedSet && !allowedSet.has(app.applywizz_id.toUpperCase())) {
        continue;
      }

      if (createdAtRange && !rowCreatedAtInRange(app, createdAtRange)) {
        continue;
      }

      const id = app.id || `notif-${app.applywizz_id}-${Buffer.from(app.job_url || '').toString('base64url').slice(0, 16)}`;
      if (dismissedNotificationIds.has(id) || (app.id && dismissedNotificationIds.has(app.id))) {
        continue;
      }

      const exists = notifications.some(
        (n) => n.id === id || (n.applywizzId === app.applywizz_id && n.jobUrl === app.job_url && n.status === app.status)
      );
      if (!exists) {
        notifications.push({
          id,
          applywizzId: app.applywizz_id,
          candidateName: resolveCandidateName(app.applywizz_id),
          companyName: app.company_name || 'Greenhouse Company',
          jobTitle: app.job_title || 'Job Opening',
          jobUrl: app.job_url,
          status: app.status as 'APPLYING' | 'APPLIED' | 'FAILED',
          reason: app.error_message || null,
          proofWebUrl: app.proof_web_url || null,
          proofFailedUrl: app.proof_failed_url || null,
          timestamp: app.updated_at || app.submitted_at || new Date().toISOString(),
        });
      }
    }
  }

  notifications.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return notifications.slice(0, limit);
}
