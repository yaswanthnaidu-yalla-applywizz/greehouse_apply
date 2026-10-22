/**
 * @fileoverview Domain types and status constants for candidate job applications.
 */

export type ApplicationStatus =
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'DRY_RUN_COMPLETE'
  | 'QUEUED'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'RETRY'
  | 'EXPIRED'
  | 'OTP_REQUIRED'
  | 'EMAIL_PROOF_PENDING'
  | 'SKIPPED'
  | 'FILTERED_OUT';


export type EmailProofStatus = 'pending' | 'captured' | 'timed_out' | 'manual_review_needed';

export const SUBMITTED_STATUSES: ApplicationStatus[] = [
  'QUEUED',
  'APPLYING',
  'APPLIED',
  'FAILED',
  'RETRY',
  'OTP_REQUIRED',
  'EMAIL_PROOF_PENDING',
];

export const FAILED_EQUIVALENT_STATUSES: ApplicationStatus[] = ['FAILED'];

export const IN_FLIGHT_STATUSES: ApplicationStatus[] = [
  'QUEUED',
  'APPLYING',
  'OTP_REQUIRED',
  'EMAIL_PROOF_PENDING',
];

export const QUEUE_DONE_STATUSES: ApplicationStatus[] = [
  'APPLIED',
  'FAILED',
  'RETRY',
  'EXPIRED',
  'OTP_REQUIRED',
  'EMAIL_PROOF_PENDING',
  'SKIPPED',
];

export const COMPLETED_STATUSES = IN_FLIGHT_STATUSES;

/** Statuses that resolve/re-ingest must never overwrite (terminal + in-flight). */
export const RESOLVE_STATUS_PRESERVE: ReadonlySet<ApplicationStatus> = new Set([
  'APPLIED',
  'FAILED',
  'APPLYING',
  'QUEUED',
  'OTP_REQUIRED',
  'SKIPPED',
  'RETRY',
  'EMAIL_PROOF_PENDING',
  'DRY_RUN_COMPLETE',
  'EXPIRED',
]);

/** Existing statuses eligible for resolve-time auto-enqueue. */
export const RESOLVE_AUTO_ENQUEUE_ELIGIBLE: ReadonlySet<ApplicationStatus> = new Set([
  'READY_FOR_REVIEW',
  'APPROVED',
]);

export interface EmailProofJson {
  from: string;
  to?: string;
  subject: string;
  received_at: string;
  body_text: string;
  body_html?: string;
}

import type { ResolvedField } from '../../types/index.js';
export type { ResolvedField };

export interface SubmissionErrorDetails {
  category?: string;
  stage?: string;
  reason?: string;
  fieldErrors?: Array<{ label?: string; selector?: string; error?: string }>;
  pageUrl?: string;
  pageTitle?: string;
  domErrors?: string[];
  [key: string]: unknown;
}

export interface ApplicationRow {
  id?: string;
  applywizz_id: string;
  task_id?: string | null;
  template_id?: string | null;
  job_url: string;
  company_name?: string | null;
  job_title?: string | null;
  status: ApplicationStatus;
  submission_order?: number | null;
  assigned_ca_email?: string | null;
  resolved_fields: ResolvedField[];
  proof_web_url?: string | null;
  proof_captured_at?: string | null;
  proof_failed_url?: string | null;
  proof_failed_captured_at?: string | null;
  proof_email_url?: string | null;
  proof_email_json?: EmailProofJson | null;
  proof_email_captured_at?: string | null;
  email_proof_status?: EmailProofStatus | null;
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
  error_details?: SubmissionErrorDetails | null;
  ats?: 'greenhouse' | 'ashby';
  scheduled_not_before?: string | null;
}

/**
 * Calculates half-open UTC bounds for an Asia/Kolkata (IST, UTC+5:30) date.
 */

export interface CreatedAtRangeFilter {
  startIso: string;
  endIso: string | null;
}

export type GteLteQuery = {
  gte(column: string, value: string): GteLteQuery;
  lt(column: string, value: string): GteLteQuery;
};


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
      email_proof_attempted_at?: string | null;
      dry_run_screenshot_url?: string | null;
      error_message?: string | null;
      job_url?: string | null;
      retry_count?: number | null;
      error_details?: any | null;
      expected_status?: ApplicationStatus;
      expected_retry_count?: number;
    };

export const OPERATOR_WORKLOAD_STATUSES: ApplicationStatus[] = ['READY_FOR_REVIEW', 'APPROVED'];

/**
 * Current review queue depth per operator (`profiles.ca_email`), not date-scoped.
 */

export interface RequiredFieldFailuresByCA {
  ca_email: string;
  failure_count: number;
  application_ids: string[];
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
  csv_job_score?: number | null;
  csvJobScore?: number | null;
  task_id?: string | null;
  taskId?: string | null;
  field_count?: number | null;
  fieldCount?: number | null;
  eligibleForSubmission?: boolean;
  questionLimitBlocked?: boolean;
}

/**
 * When resolved_fields is empty, copies fields_schema from scanned_job_templates and persists the snapshot.
 */

export type CandidateQueueStatus =
  | 'NO_APPLICATIONS'
  | 'READY'
  | 'IN_PROGRESS'
  | 'DONE';

export const QUEUE_STATUS_IN_PROGRESS: ReadonlySet<ApplicationStatus> = new Set(['APPROVED', ...IN_FLIGHT_STATUSES]);

export const QUEUE_STATUS_DONE: ReadonlySet<ApplicationStatus> = new Set(QUEUE_DONE_STATUSES);

/**
 * Derives dashboard queue_status for one candidate from all candidate_applications statuses.
 * Priority when mixed: IN_PROGRESS > READY > DONE > NO_APPLICATIONS.
 */

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

export interface NotificationItem {
  id: string;
  applywizzId: string;
  candidateName?: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  status: 'APPLYING' | 'APPLIED' | 'FAILED' | 'RETRY';
  reason?: string | null;
  proofWebUrl?: string | null;
  proofFailedUrl?: string | null;
  timestamp: string;
}
