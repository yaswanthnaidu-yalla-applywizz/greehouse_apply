/**
 * @fileoverview Application DTO serialization, proof URL hydration, and queue status derivation.
 */

import { getDbClient, isSupabaseConfigured } from "../client.js";
import {
  getSignedProofUrl,
  PROOFS_BUCKET,
  PROOFS_FAILED_BUCKET,
  PROOFS_MAIL_BUCKET,
  webProofStoragePath,
  failedProofStoragePath,
  emailProofStoragePath,
  isApplicationUuid,
} from "../storage.js";
import { hydrateApplicationResolvedFields } from "../applicationFieldHydration.js";
import { resolveAssignedCaEmail } from "../sandboxAssignment.js";
import {
  normalizeOperatorErrorMessage,
  statusShouldPersistOperatorError,
} from "../../operator/operatorErrorMessages.js";
import { upsertApplication } from "./crud.js";
import {
  QUEUE_STATUS_IN_PROGRESS,
  QUEUE_STATUS_DONE,
  type ApplicationRow,
  type ApplicationDto,
  type ApplicationStatus,
  type CandidateQueueStatus,
  type EmailProofJson,
  type EmailProofStatus,
} from "./types.js";

export async function hydrateApplicationProofUrls(app: ApplicationRow): Promise<ApplicationRow> {
  if (!isSupabaseConfigured()) {
    return app;
  }

  let storageKey = app.id && isApplicationUuid(app.id) ? app.id : null;
  if (!storageKey && app.applywizz_id && app.job_url) {
    try {
      const supabase = getDbClient();
      const { data } = await supabase
        .from('gh_candidate_applications')
        .select('id')
        .eq('applywizz_id', app.applywizz_id)
        .eq('job_url', app.job_url)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.id && isApplicationUuid(data.id)) {
        storageKey = data.id;
      }
    } catch {}
  }

  if (!storageKey) {
    storageKey = app.id || app.applywizz_id || null;
  }

  if (!storageKey) {
    return app;
  }

  const hydrated = { ...app };

  if (hydrated.proof_web_url) {
    let signed = await getSignedProofUrl(PROOFS_BUCKET, webProofStoragePath(storageKey));
    if (!signed && app.applywizz_id && storageKey !== app.applywizz_id) {
      signed = await getSignedProofUrl(PROOFS_BUCKET, webProofStoragePath(app.applywizz_id));
    }
    if (signed) hydrated.proof_web_url = signed;
  }
  if (hydrated.proof_failed_url) {
    let signed = await getSignedProofUrl(PROOFS_FAILED_BUCKET, failedProofStoragePath(storageKey));
    if (!signed && app.applywizz_id && storageKey !== app.applywizz_id) {
      signed = await getSignedProofUrl(PROOFS_FAILED_BUCKET, failedProofStoragePath(app.applywizz_id));
    }
    if (signed) hydrated.proof_failed_url = signed;
  }
  if (hydrated.proof_email_url) {
    let signed = await getSignedProofUrl(PROOFS_MAIL_BUCKET, emailProofStoragePath(storageKey));
    if (!signed && app.applywizz_id && storageKey !== app.applywizz_id) {
      signed = await getSignedProofUrl(PROOFS_MAIL_BUCKET, emailProofStoragePath(app.applywizz_id));
    }
    if (signed) hydrated.proof_email_url = signed;
  }

  return hydrated;
}

/**
 * Sets the confirmation proof URL and capture timestamp for an application by UUID.
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
  const assignedCaEmail = resolveAssignedCaEmail(
    merged.assigned_ca_email || merged.assignedCaEmail || null
  );
  const createdAt = merged.created_at || merged.createdAt;
  const updatedAt = merged.updated_at || merged.updatedAt;
  const retryCount = Number(merged.retry_count ?? merged.retryCount ?? 0);
  const fieldCount = merged.field_count ?? merged.fieldCount ?? null;
  const csvJobScore = merged.csv_job_score ?? merged.csvJobScore ?? null;
  const taskId = merged.task_id ?? merged.taskId ?? null;

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
    csv_job_score: csvJobScore,
    csvJobScore,
    task_id: taskId,
    taskId,
    field_count: fieldCount,
    fieldCount,
    eligibleForSubmission: true,
    questionLimitBlocked: false,
  };
}


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

