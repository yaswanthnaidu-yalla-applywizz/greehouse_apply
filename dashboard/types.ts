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
} from '../src/types/index.js';

export type { ApplyWizzCandidateProfile, CandidateJobApplication, ResolvedField };

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
