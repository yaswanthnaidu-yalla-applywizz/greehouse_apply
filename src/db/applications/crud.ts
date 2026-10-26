/**
 * @fileoverview Core CRUD operations and status persistence for candidate applications.
 */

import { getDbClient, isSupabaseConfigured } from "../client.js";
import { getSandboxCaEmail, resolveAssignedCaEmail } from "../sandboxAssignment.js";
import { isApplicationUuid } from "../storage.js";
import { insertApplicationEvent } from "../events.js";
import { createLogger } from "../../utils/logger.js";
import { hasAnyNonEmptyResolvedField } from "../../utils/resolvedFields.js";
import {
  normalizeOperatorErrorMessage,
  OperatorErrors,
  statusShouldPersistOperatorError,
} from "../../operator/operatorErrorMessages.js";
import { memoryApplications } from "./memoryStore.js";
import {
  RESOLVE_STATUS_PRESERVE,
  type ApplicationRow,
  type ApplicationStatus,
  type EmailProofJson,
  type EmailProofStatus,
  type UpdateStatusExtra,
} from "./types.js";

const log = createLogger("ApplicationsCrud");

const profileCaEmailCache = new Map<string, string>();

export function cacheApplicationLocally(app: ApplicationRow): ApplicationRow {
  const id =
    app.id ||
    `${app.applywizz_id}_${Buffer.from(app.job_url || '').toString('base64url').slice(0, 16)}`;
  const sandboxCaEmail = getSandboxCaEmail();
  const cached = {
    ...app,
    ...(sandboxCaEmail ? { assigned_ca_email: sandboxCaEmail } : {}),
    id,
  };
  memoryApplications.set(id, cached);
  if (app.applywizz_id && app.applywizz_id !== id) {
    memoryApplications.set(app.applywizz_id, cached);
  }
  return cached;
}

/**
 * Upserts a candidate application record into Supabase or local memory.
 * Keyed by task_id or the generated legacy application key.
 */
export async function upsertApplication(
  app: Partial<ApplicationRow> & { applywizz_id: string; job_url: string; resolved_fields: any[] }
): Promise<ApplicationRow> {
  const payload: any = {
    status: (app.status || 'READY_FOR_REVIEW') as ApplicationStatus,
    ...app,
    updated_at: new Date().toISOString(),
  };
  const sandboxCaEmail = getSandboxCaEmail();
  if (sandboxCaEmail) {
    payload.assigned_ca_email = sandboxCaEmail;
    profileCaEmailCache.set(payload.applywizz_id, sandboxCaEmail);
  }

  let existingRow: Pick<ApplicationRow, 'status' | 'resolved_fields'> | null = null;
  if (payload.task_id) {
    try {
      const existing = await getApplicationByTaskId(payload.task_id);
      if (existing) {
        existingRow = { status: existing.status, resolved_fields: existing.resolved_fields };
      }
    } catch {
      /* fall through */
    }
  } else if (payload.applywizz_id && payload.job_url) {
    try {
      const existing = await getApplicationByCandidateAndJob(payload.applywizz_id, payload.job_url);
      if (existing) {
        existingRow = { status: existing.status, resolved_fields: existing.resolved_fields };
      }
    } catch {
      /* fall through */
    }
  }

  if (
    existingRow?.status &&
    RESOLVE_STATUS_PRESERVE.has(existingRow.status) &&
    payload.status !== 'SKIPPED'
  ) {
    delete payload.status;
  }

  if (
    payload.status !== 'SKIPPED' &&
    Array.isArray(payload.resolved_fields) &&
    !hasAnyNonEmptyResolvedField(payload.resolved_fields) &&
    payload.applywizz_id &&
    payload.job_url
  ) {
    const existingFields = existingRow?.resolved_fields;
    if (hasAnyNonEmptyResolvedField(existingFields)) {
      payload.resolved_fields = existingFields;
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

  if (!sandboxCaEmail && !payload.assigned_ca_email && payload.applywizz_id && isSupabaseConfigured()) {
    const cachedCaEmail = profileCaEmailCache.get(payload.applywizz_id);
    if (cachedCaEmail) {
      payload.assigned_ca_email = cachedCaEmail;
    } else {
      try {
        const supabase = getDbClient();
        const { data: profile } = await supabase
          .from('profiles')
          .select('ca_email')
          .eq('applywizz_id', payload.applywizz_id)
          .maybeSingle();
        if (profile?.ca_email) {
          const normalized = profile.ca_email.trim().toLowerCase();
          payload.assigned_ca_email = normalized;
          profileCaEmailCache.set(payload.applywizz_id, normalized);
        }
      } catch {
        /* fall through on profile lookup failure */
      }
    }
  } else if (payload.assigned_ca_email && payload.applywizz_id) {
    payload.assigned_ca_email = resolveAssignedCaEmail(payload.assigned_ca_email);
    profileCaEmailCache.set(payload.applywizz_id, String(payload.assigned_ca_email).trim().toLowerCase());
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const onConflict = payload.task_id ? 'task_id' : 'legacy_application_key';
      let { data, error } = await supabase
        .from('gh_candidate_applications')
        .upsert(payload, { onConflict })
        .select()
        .single();

      if (error && (
        (error.message.includes("'task_id' column") && error.message.includes('schema cache')) ||
        error.message.includes('legacy_application_key')
      )) {
        log.warn(`[DB] Supabase schema cache missing 'task_id' or 'legacy_application_key' — retrying on (applywizz_id,job_url)`);
        const fallbackPayload = { ...payload };
        delete fallbackPayload.task_id;
        const retryResult = await supabase
          .from('gh_candidate_applications')
          .upsert(fallbackPayload, { onConflict: 'applywizz_id,job_url' })
          .select()
          .single();
        data = retryResult.data;
        error = retryResult.error;
      }

      if (error && (error.message.includes('ON CONFLICT') || error.message.includes('unique or exclusion constraint'))) {
        let query = supabase.from('gh_candidate_applications').select('id');
        if (payload.task_id) {
          query = query.eq('task_id', payload.task_id);
        } else {
          query = query.eq('applywizz_id', payload.applywizz_id).eq('job_url', payload.job_url);
        }
        const { data: existingApp } = await query.limit(1).maybeSingle();
        if (existingApp?.id) {
          const updateRes = await supabase
            .from('gh_candidate_applications')
            .update(payload)
            .eq('id', existingApp.id)
            .select()
            .single();
          data = updateRes.data;
          error = updateRes.error;
        } else {
          const insertRes = await supabase
            .from('gh_candidate_applications')
            .insert(payload)
            .select()
            .single();
          data = insertRes.data;
          error = insertRes.error;
        }
      }

      if (!error && data) {
        const row = data as ApplicationRow;
        memoryApplications.set(row.id!, row);
        if (row.task_id) {
          memoryApplications.set(`task_${row.task_id}`, row);
        }
        const compositeKey = `${row.applywizz_id}_${Buffer.from(row.job_url).toString('base64url').slice(0, 16)}`;
        memoryApplications.set(compositeKey, row);
        return row;
      }
      if (error) {
        const missingProfileFk = /(?:gh_)?candidate_applications_applywizz_id_fkey/i.test(error.message);
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

  if (!payload.status && existingRow?.status) {
    payload.status = existingRow.status;
  } else if (!payload.status) {
    payload.status = 'READY_FOR_REVIEW';
  }

  const fallbackId = app.id || (payload.task_id ? `task_${payload.task_id}` : `${app.applywizz_id}_${Buffer.from(app.job_url).toString('base64url').slice(0, 16)}`);
  payload.id = fallbackId;
  memoryApplications.set(fallbackId, payload);
  if (payload.task_id) {
    memoryApplications.set(`task_${payload.task_id}`, payload);
  }
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
          .from('gh_candidate_applications')
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
        .from('gh_candidate_applications')
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

  // 3. Disk fallback removed per V2 Supabase authority rule
  return null;
}

/**
 * Retrieves a candidate application by candidate ID and job URL.
 */
/**
 * Retrieves a candidate application by external task ID.
 */
export async function getApplicationByTaskId(
  taskId: string
): Promise<ApplicationRow | null> {
  if (!taskId) return null;
  const memoryKey = `task_${taskId}`;
  const cached = memoryApplications.get(memoryKey);
  if (cached) return cached;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('*')
        .eq('task_id', taskId)
        .maybeSingle();

      if (!error && data) {
        const row = data as ApplicationRow;
        memoryApplications.set(row.id!, row);
        memoryApplications.set(memoryKey, row);
        return row;
      }
    } catch (err: any) {
      log.warn(`[DB] getApplicationByTaskId exception (${taskId}):`, err?.message || err);
    }
  }

  for (const app of memoryApplications.values()) {
    if (app.task_id === taskId) {
      return app;
    }
  }

  return null;
}

export async function getApplicationByCandidateAndJob(
  applywizzId: string,
  jobUrl: string
): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .eq('job_url', jobUrl)
        .is('task_id', null)
        .maybeSingle();

      if (!error && data) {
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  for (const app of memoryApplications.values()) {
    if (
      app.task_id == null &&
      app.applywizz_id === applywizzId &&
      (app.job_url === jobUrl || jobUrl.includes(app.job_url))
    ) {
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
          .from('gh_candidate_applications')
          .update(updatePayload)
          .eq('id', id);
      } else if (cleanApplywizz && targetJobUrl) {
        updateRes = await supabase
          .from('gh_candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', cleanApplywizz)
          .eq('job_url', targetJobUrl);
      } else if (cleanApplywizz) {
        updateRes = await supabase
          .from('gh_candidate_applications')
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
    if (extra.email_proof_attempted_at !== undefined) updatePayload.email_proof_attempted_at = extra.email_proof_attempted_at;
    if (extra.dry_run_screenshot_url !== undefined) updatePayload.dry_run_screenshot_url = extra.dry_run_screenshot_url;
    if (extra.retry_count !== undefined) updatePayload.retry_count = extra.retry_count;
    if (extra.error_details !== undefined) updatePayload.error_details = extra.error_details;
  }
  const expectedStatus = extra && typeof extra === 'object' ? extra.expected_status : undefined;
  const expectedRetryCount = extra && typeof extra === 'object' ? extra.expected_retry_count : undefined;

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
        let statusQuery = supabase.from('gh_candidate_applications').select('status');
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
      const query = supabase
        .from('gh_candidate_applications')
        .update(updatePayload)
        .select('id');
      let updateRes;
      if (isUuid) {
        let guardedQuery = query.eq('id', id);
        if (expectedStatus) guardedQuery = guardedQuery.eq('status', expectedStatus);
        if (expectedRetryCount !== undefined) guardedQuery = guardedQuery.eq('retry_count', expectedRetryCount);
        updateRes = await guardedQuery;
      } else if (targetJobUrl) {
        let guardedQuery = query.eq('applywizz_id', cleanApplywizz).eq('job_url', targetJobUrl);
        if (expectedStatus) guardedQuery = guardedQuery.eq('status', expectedStatus);
        if (expectedRetryCount !== undefined) guardedQuery = guardedQuery.eq('retry_count', expectedRetryCount);
        updateRes = await guardedQuery;
      } else {
        let guardedQuery = query.eq('applywizz_id', cleanApplywizz);
        if (expectedStatus) guardedQuery = guardedQuery.eq('status', expectedStatus);
        if (expectedRetryCount !== undefined) guardedQuery = guardedQuery.eq('retry_count', expectedRetryCount);
        updateRes = await guardedQuery;
      }
      if (updateRes?.error) {
        log.error(`[DB] updateStatus Supabase error (${id}, ${status}):`, updateRes.error.message);
        const { emitFailureDiagnostic } = await import('../../utils/failureDiagnostics.js');
        await emitFailureDiagnostic({
          category: 'SUBMIT_STATUS_PERSIST',
          stage: 'status_persistence',
          reason: `Failed to persist application status ${status}: ${updateRes.error.message}`,
          error: updateRes.error,
          applicationId: isUuid ? id : undefined,
          applywizzId: isUuid ? undefined : cleanApplywizz,
          jobUrl: targetJobUrl,
          isTerminal: false,
          isRetryable: true,
        }).catch(() => {});
        throw updateRes.error;
      }
      if (!updateRes?.data || updateRes.data.length === 0) {
        const error = new Error(
          expectedStatus || expectedRetryCount !== undefined
            ? `Application ${id} no longer matches the expected state; refusing the ${status} transition.`
            : `No application row updated for ${id}`
        );
        log.error(`[DB] updateStatus Supabase update matched no rows (${id}, ${status})`);
        throw error;
      }
    } catch (err: any) {
      log.error(`[DB] updateStatus exception (${id}, ${status}):`, err);
      const { emitFailureDiagnostic } = await import('../../utils/failureDiagnostics.js');
      await emitFailureDiagnostic({
        category: 'SUBMIT_STATUS_PERSIST',
        stage: 'status_persistence',
        reason: `Failed to persist application status ${status}: ${err?.message || String(err)}`,
        error: err,
        applicationId: isUuid ? id : undefined,
        applywizzId: isUuid ? undefined : cleanApplywizz,
        jobUrl: targetJobUrl,
        isTerminal: false,
        isRetryable: true,
      }).catch(() => {});
      // If Supabase failed due to network / ENOTFOUND, allow memory fallback to update status
      const isNetworkErr = /fetch failed|getaddrinfo|ENOTFOUND|ECONNREFUSED/i.test(err?.message || '');
      if (!isNetworkErr) {
        throw err;
      }
    }
  }

  const existing = memoryApplications.get(id);
  if (expectedStatus && existing?.status !== expectedStatus) {
    throw new Error(`Application ${id} is no longer ${expectedStatus}; refusing the ${status} transition.`);
  }
  if (expectedRetryCount !== undefined && Number(existing?.retry_count ?? 0) !== expectedRetryCount) {
    throw new Error(`Application ${id} retry counter changed; refusing the ${status} transition.`);
  }
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
          .from('gh_candidate_applications')
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
          .from('gh_candidate_applications')
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
 * Re-signs a private bucket proof URL for an explicit proof retrieval request.
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


export async function listApplications(filter?: {
  status?: ApplicationStatus;
  applywizzId?: string;
}): Promise<ApplicationRow[]> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const buildQuery = () => {
        let q = supabase.from('gh_candidate_applications').select('*');
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
