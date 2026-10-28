/**
 * @fileoverview Application Status Badge component (Phase V2-UI).
 *
 * References:
 * - 04-ui-ux.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
 */

import React from 'react';
import type { ApplicationStatus } from '../../src/db/applications.js';

export interface ApplicationStatusBadgeProps {
  status: ApplicationStatus | string;
  proofWebUrl?: string | null;
  proofEmailUrl?: string | null;
  proofEmailJson?: { from: string; subject: string; received_at: string; body_text: string } | null;
  emailProofStatus?: 'pending' | 'captured' | 'timed_out' | null;
  applicationId?: string;
  jobUrl?: string;
  onStatusChange?: (
    newStatus: ApplicationStatus,
    updatedApp: any,
    options?: { persist?: boolean }
  ) => void;
  className?: string;
  apiBaseUrl?: string;
}

/**
 * Renders an application status badge.
 */
export const ApplicationStatusBadge: React.FC<ApplicationStatusBadgeProps> = ({
  status,
  proofWebUrl,
  proofEmailUrl,
  proofEmailJson,
  className = '',
}) => {
  switch (status) {
    case 'QUEUED':
      return (
        <span
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 ${className}`}
          title="Application queued for submission daemon"
        >
          <span className="w-2 h-2 rounded-full bg-[#30d158] animate-pulse"></span>
          <span>Queued</span>
        </span>
      );

    case 'OTP_REQUIRED':
    case 'APPLYING':
      return (
        <span
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-[#ff9f0a]/15 text-[#ff9f0a] border border-[#ff9f0a]/30 animate-pulse ${className}`}
          title="Automated submission in progress"
        >
          <span className="w-2 h-2 rounded-full bg-[#ff9f0a] animate-pulse"></span>
          <span>Submitting...</span>
        </span>
      );

    case 'EMAIL_PROOF_PENDING':
      return (
        <span
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-[#ff9f0a]/15 text-[#ff9f0a] border border-[#ff9f0a]/30 animate-pulse ${className}`}
          title="Web submission confirmed — verifying confirmation email..."
        >
          <span className="w-2 h-2 rounded-full bg-[#ff9f0a] animate-pulse"></span>
          <span>Email Pending...</span>
        </span>
      );

    case 'APPLIED':
      if (proofWebUrl && !proofEmailUrl && !proofEmailJson) {
        return (
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 ${className}`}
            title="A-Applied: Web confirmation proof captured, email proof pending or timed out"
          >
            <span className="w-2 h-2 rounded-full bg-[#30d158]"></span>
            <span>A-Applied</span>
          </span>
        );
      }
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 ${className}`}
          title="Applied & Verified: Both web and confirmation email proofs captured"
        >
          <span className="w-2 h-2 rounded-full bg-[#30d158]"></span>
          <span>Applied &amp; Verified</span>
        </span>
      );

    case 'DRY_RUN_COMPLETE':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#3a3a3c] text-[#ffffff] border border-[#48484a] ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-[#8e8e93]"></span>
          <span>Dry-Run Complete</span>
        </span>
      );

    case 'FAILED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30 ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-[#ff453a]"></span>
          <span>Submission Failed</span>
        </span>
      );

    case 'EXPIRED':
    case 'SKIPPED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#ff9f0a]/15 text-[#ff9f0a] border border-[#ff9f0a]/30 ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-[#ff9f0a]"></span>
          <span>{status === 'SKIPPED' ? 'Skipped' : 'Closed / Expired'}</span>
        </span>
      );

    case 'READY_FOR_REVIEW':
    default:
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#3a3a3c] text-[#ffffff] border border-[#48484a] ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-[#8e8e93]"></span>
          <span>Ready for Review</span>
        </span>
      );
  }
};

export default ApplicationStatusBadge;
