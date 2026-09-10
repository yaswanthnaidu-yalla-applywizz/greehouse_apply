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
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'EXPIRED'
  | 'OTP_REQUIRED'
  | 'CAPTCHA_TIMEOUT';

export interface ApplicationDetail {
  id?: string;
  applywizz_id: string;
  job_url: string;
  company_name?: string | null;
  job_title?: string | null;
  status: ApplicationStatus;
  resolved_fields: ResolvedField[];
  proof_web_url?: string | null;
  proof_captured_at?: string | null;
  proof_email_url?: string | null;
  proof_email_captured_at?: string | null;
  dry_run_screenshot_url?: string | null;
  error_message?: string | null;
  submitted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

