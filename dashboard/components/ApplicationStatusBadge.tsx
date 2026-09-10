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
  applicationId?: string;
  onStatusChange?: (newStatus: ApplicationStatus, updatedApp: any) => void;
  className?: string;
  apiBaseUrl?: string;
}

/**
 * Renders an application status badge and polls `GET /api/applications/:id`
 * every 2 seconds when status is `APPLYING`.
 */
export const ApplicationStatusBadge: React.FC<ApplicationStatusBadgeProps> = ({
  status,
  proofWebUrl,
  proofEmailUrl,
  applicationId,
  onStatusChange,
  className = '',
  apiBaseUrl = '',
}) => {
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if ((status !== 'APPLYING' && status !== 'QUEUED') || !applicationId) {
      return;
    }

    const pollInterval = setInterval(async () => {
      try {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const url = `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}`;
        const res = await fetch(url, { headers });
        if (res.ok) {
          const appData = await res.json();
          if (appData.status && appData.status !== statusRef.current) {
            console.log(
              `[StatusBadge] 🔄 Application ${applicationId} status updated: ${statusRef.current} -> ${appData.status}`
            );
            if (onStatusChange) {
              onStatusChange(appData.status as ApplicationStatus, appData);
            }
          }
        }
      } catch (err) {
        console.warn(`[StatusBadge] Polling error for ${applicationId}:`, err);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [status, applicationId, onStatusChange, apiBaseUrl]);

  switch (status) {
    case 'QUEUED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#FED7AA] text-[#9A3412] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] animate-pulse ${className}`}
          title="Queued for automated submission daemon"
        >
          <span className="w-2 h-2 rounded-full bg-[#EA580C]"></span>
          <span>Queued for Submit</span>
        </span>
      );

    case 'APPLIED':
      if (proofWebUrl && !proofEmailUrl) {
        return (
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#E0F2FE] text-[#0369A1] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
            title="A-Applied: Web confirmation proof captured, email proof pending or timed out"
          >
            <span className="w-2 h-2 rounded-full bg-[#0284C7]"></span>
            <span>A-Applied</span>
          </span>
        );
      }
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#9AC89A] text-[#1E4620] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
          title="Applied & Verified: Both web and confirmation email proofs captured"
        >
          <span className="w-2 h-2 rounded-full bg-[#1E4620]"></span>
          <span>Applied &amp; Verified</span>
        </span>
      );

    case 'APPLYING':
      return (
        <span
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#E88474] text-white border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] animate-pulse ${className}`}
        >
          <span className="w-2 h-2 rounded-full border-2 border-white border-t-transparent animate-spin"></span>
          <span>Submitting... (Live)</span>
        </span>
      );

    case 'DRY_RUN_COMPLETE':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#B8D4E8] text-[#1E3A5F] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-[#1E3A5F]"></span>
          <span>Dry-Run Complete</span>
        </span>
      );

    case 'OTP_REQUIRED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold font-mono bg-[#F59E0B] text-[#451A03] border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] ring-2 ring-[#FBBF24] animate-pulse ${className}`}
          title="Verification code required — enter OTP to complete submission"
        >
          <span className="text-sm leading-none">🔐</span>
          <span>OTP Required</span>
        </span>
      );

    case 'FAILED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#EF4444] text-white border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-white"></span>
          <span>Submission Failed</span>
        </span>
      );

    case 'EXPIRED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#E2E8F0] text-[#475569] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
        >
          <span>Closed / Expired</span>
        </span>
      );

    case 'CAPTCHA_TIMEOUT':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#F97316] text-white border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
          title="Manual CAPTCHA challenge timed out after 5 minutes"
        >
          <span className="w-2 h-2 rounded-full bg-white"></span>
          <span>CAPTCHA Timeout</span>
        </span>
      );

    case 'READY_FOR_REVIEW':
    default:
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono bg-[#F4D66B] text-[#5C4A0A] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-[#5C4A0A]"></span>
          <span>Ready for Review</span>
        </span>
      );
  }
};

export default ApplicationStatusBadge;
