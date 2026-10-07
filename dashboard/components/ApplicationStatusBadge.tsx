/**
 * @fileoverview Application Status Badge component with real-time polling during APPLYING state (Phase V2-UI).
 *
 * References:
 * - 04-ui-ux.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
 */

import React, { useEffect, useRef } from 'react';
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
 * Renders an application status badge and polls `GET /api/applications/:id`
 * every 2 seconds when status is `APPLYING` or `QUEUED`.
 */
export const ApplicationStatusBadge: React.FC<ApplicationStatusBadgeProps> = ({
  status,
  proofWebUrl,
  proofEmailUrl,
  proofEmailJson,
  emailProofStatus,
  applicationId,
  jobUrl,
  onStatusChange,
  className = '',
  apiBaseUrl = '',
}) => {
  const statusRef = useRef(status);
  statusRef.current = status;
  const emailProofStatusRef = useRef(emailProofStatus);
  emailProofStatusRef.current = emailProofStatus;
  const proofWebUrlRef = useRef(proofWebUrl);
  proofWebUrlRef.current = proofWebUrl;
  const proofEmailUrlRef = useRef(proofEmailUrl);
  proofEmailUrlRef.current = proofEmailUrl;
  const lastPolledFailedProofRef = useRef<string | null>(null);

  useEffect(() => {
    const shouldPollStatus =
      status === 'APPLYING' ||
      status === 'QUEUED' ||
      status === 'OTP_REQUIRED' ||
      status === 'CAPTCHA_REQUIRED' ||
      status === 'EMAIL_PROOF_PENDING' ||
      status === 'FAILED';
    const shouldPollEmailProof = status === 'APPLIED' && emailProofStatus === 'pending';
    if ((!shouldPollStatus && !shouldPollEmailProof) || !applicationId) {
      return;
    }

    const pollInterval = setInterval(async () => {
      try {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const url = `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}${jobUrl ? `?jobUrl=${encodeURIComponent(jobUrl)}` : ''}`;
        const res = await fetch(url, { headers });
        if (res.ok) {
          const appData = await res.json();
          const nextEmailStatus =
            appData.email_proof_status || appData.emailProofStatus || emailProofStatusRef.current;
          const nextProofWeb = appData.proof_web_url || appData.proofWebUrl || null;
          const nextProofEmail = appData.proof_email_url || appData.proofEmailUrl || null;
          const nextProofFailed = appData.proof_failed_url || appData.proofFailedUrl || null;
          const nextProofEmailJson = appData.proof_email_json || appData.proofEmailJson || null;
          const emailProofArrived =
            Boolean(nextProofEmailJson) ||
            (Boolean(nextProofEmail) && nextProofEmail !== proofEmailUrlRef.current);
          const webProofArrived = Boolean(nextProofWeb) && nextProofWeb !== proofWebUrlRef.current;
          const failedProofArrived =
            Boolean(nextProofFailed) && nextProofFailed !== lastPolledFailedProofRef.current;
          if (nextProofFailed) {
            lastPolledFailedProofRef.current = nextProofFailed;
          }
          const emailStatusChanged =
            nextEmailStatus && nextEmailStatus !== emailProofStatusRef.current;
          const statusChanged = appData.status && appData.status !== statusRef.current;

          if (statusChanged || emailStatusChanged || emailProofArrived || webProofArrived || failedProofArrived) {
            if (statusChanged) {
              console.log(
                `[StatusBadge] 🔄 Application ${applicationId} status updated: ${statusRef.current} -> ${appData.status}`
              );
            }
            if (onStatusChange) {
              onStatusChange((appData.status || statusRef.current) as ApplicationStatus, appData, {
                persist: false,
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[StatusBadge] Polling error for ${applicationId}:`, err);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [status, emailProofStatus, applicationId, jobUrl, onStatusChange, apiBaseUrl, proofWebUrl, proofEmailUrl]);

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

    case 'CAPTCHA_REQUIRED':
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

    case 'CAPTCHA_TIMEOUT':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#ff9f0a]/15 text-[#ff9f0a] border border-[#ff9f0a]/30 ${className}`}
          title="Session timed out after 5 minutes"
        >
          <span className="w-2 h-2 rounded-full bg-[#ff9f0a]"></span>
          <span>Timeout</span>
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
