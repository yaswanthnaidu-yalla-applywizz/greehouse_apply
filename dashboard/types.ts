/**
 * @fileoverview Frontend Dashboard Type Definitions.
 *
 * References:
 * - 04-ui-ux.md
 * - 05-backend-schema.md
 */

import type {
  ApplyWizzCandidateProfile,
  CandidateJobApplication,
  ResolvedField,
  SourceTag,
} from '../src/types/index.js';
// Re-exported rather than redeclared: the DB CHECK constraint is the source of
// truth for these unions, and a local copy silently drifts from it.
import type {
  ApplicationStatus,
  CandidateQueueStatus,
  EmailProofStatus,
} from '../src/db/applications.js';

export type { ApplyWizzCandidateProfile, CandidateJobApplication, ResolvedField, SourceTag };

/**
 * Candidate summary record returned by `GET /api/candidates`.
 */
export interface CandidateSummary {
  applywizzId: string;
  clientName: string;
  email: string;
  location: string;
  totalJobs: number;
  job_count: number;
  queue_status: CandidateQueueStatus;
  readyCount: number;
  expiredCount: number;
  status: 'READY' | 'PENDING' | 'EXPIRED';
  syncedAt?: string;
  resumeAvailable: boolean;
}

/**
 * Detailed candidate record with assigned jobs returned by `GET /api/candidates/:id`.
 */
export interface CandidateDetail {
  applywizzId: string;
  clientName: string;
  profile?: ApplyWizzCandidateProfile;
  resumeUrl?: string | null;
  resumeFilename?: string | null;
  jobs: Array<{
    rawUrl: string;
    canonicalUrl: string;
    companyName: string;
    jobTitle: string;
    status: string;
    fieldsCount: number;
    hasManualEdits?: boolean;
    error_message?: string | null;
    /** Owner tag the queue filter reads to drop another candidate's rows. */
    applywizz_id?: string;
    applywizzId?: string;
  }>;
}

/**
 * Aggregated dashboard pipeline metrics returned by `GET /api/stats`.
 */
export interface DashboardDateRangeMeta {
  preset: string;
  from: string | null;
  to: string | null;
  label: string;
}

export interface DashboardStats {
  totalCandidates: number;
  totalApplications: number;
  successfulApplications: number;
  failedApplications: number;
  uniqueScannedJobs: number;
  totalFieldsPopulated: number;
  supabaseTaggedCount: number;
  aiTaggedCount: number;
  supabasePercentage: number;
  aiPercentage: number;
  pipelineStatus: 'READY' | 'IDLE' | 'PROCESSING';
  dateRange?: DashboardDateRangeMeta;
}

export type { ApplicationStatus, EmailProofStatus };

export interface ApplicationDetail {
  id?: string;
  applywizz_id: string;
  applywizzId?: string;
  job_url: string;
  jobUrl?: string;
  company_name?: string | null;
  companyName?: string | null;
  job_title?: string | null;
  jobTitle?: string | null;
  status: ApplicationStatus;
  resolved_fields: ResolvedField[];
  resolvedFields?: ResolvedField[];
  proof_web_url?: string | null;
  proofWebUrl?: string | null;
  proof_captured_at?: string | null;
  proofCapturedAt?: string | null;
  proof_failed_url?: string | null;
  proofFailedUrl?: string | null;
  proof_failed_captured_at?: string | null;
  proofFailedCapturedAt?: string | null;
  proof_email_url?: string | null;
  proofEmailUrl?: string | null;
  proof_email_json?: {
    from: string;
    subject: string;
    received_at: string;
    body_text: string;
  } | null;
  proofEmailJson?: {
    from: string;
    subject: string;
    received_at: string;
    body_text: string;
  } | null;
  proof_email_captured_at?: string | null;
  proofEmailCapturedAt?: string | null;
  email_proof_status?: EmailProofStatus | null;
  emailProofStatus?: EmailProofStatus | null;
  email_proof_attempted_at?: string | null;
  emailProofAttemptedAt?: string | null;
  dry_run_screenshot_url?: string | null;
  dryRunScreenshotUrl?: string | null;
  error_message?: string | null;
  errorMessage?: string | null;
  submitted_at?: string | null;
  submittedAt?: string | null;
  created_at?: string;
  updated_at?: string;
}

