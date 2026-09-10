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
  }>;
}

/**
 * Aggregated dashboard pipeline metrics returned by `GET /api/stats`.
 */
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
}

export type ApplicationStatus =
  | 'READY_FOR_REVIEW'
  | 'DRY_RUN_COMPLETE'
  | 'QUEUED'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'EXPIRED'
  | 'OTP_REQUIRED'
  | 'CAPTCHA_TIMEOUT';

export type EmailProofStatus = 'pending' | 'captured' | 'timed_out';

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
  proof_email_url?: string | null;
  proofEmailUrl?: string | null;
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

