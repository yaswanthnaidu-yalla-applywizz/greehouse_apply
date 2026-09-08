/**
 * @fileoverview Application Status Badge component with real-time polling during APPLYING state.
 *
 * References:
 * - 04-ui-ux.md
 * - V2-implementation.md (Phase V2-5)
 */

import React, { useEffect, useRef } from 'react';
import type { ApplicationStatus } from '../../src/db/applications.js';

export interface ApplicationStatusBadgeProps {
  status: ApplicationStatus | string;
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
  applicationId,
  onStatusChange,
  className = '',
  apiBaseUrl = '',
}) => {
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (status !== 'APPLYING' || !applicationId) {
      return;
    }

    const pollInterval = setInterval(async () => {
      try {
        const url = `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}`;
        const res = await fetch(url);
        if (res.ok) {
          const appData = await res.json();
          if (appData.status && appData.status !== statusRef.current) {
            console.log(`[StatusBadge] 🔄 Application ${applicationId} status updated: ${statusRef.current} -> ${appData.status}`);
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
    case 'APPLIED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-emerald-50 text-emerald-800 border border-emerald-400 shadow-sm ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
          <span>Applied &amp; Verified</span>
        </span>
      );

    case 'APPLYING':
      return (
        <span
          className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-amber-50 text-amber-900 border border-amber-400 shadow-sm animate-pulse ${className}`}
        >
          <span className="w-2 h-2 rounded-full border-2 border-amber-600 border-t-transparent animate-spin"></span>
          <span>Submitting... (Live)</span>
        </span>
      );

    case 'DRY_RUN_COMPLETE':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-blue-50 text-blue-800 border border-blue-400 shadow-sm ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-blue-600"></span>
          <span>Dry-Run Complete</span>
        </span>
      );

    case 'CAPTCHA_REQUIRED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-orange-50 text-orange-900 border border-orange-500 shadow-sm ${className}`}
        >
          <span>🛡️</span>
          <span>CAPTCHA Required</span>
        </span>
      );

    case 'FAILED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-rose-50 text-rose-800 border border-rose-400 shadow-sm ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-rose-600"></span>
          <span>Submission Failed</span>
        </span>
      );

    case 'EXPIRED':
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-slate-100 text-slate-700 border border-slate-300 shadow-sm ${className}`}
        >
          <span>Closed / Expired</span>
        </span>
      );

    case 'READY_FOR_REVIEW':
    default:
      return (
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold font-mono bg-slate-50 text-slate-800 border border-slate-300 shadow-sm ${className}`}
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
          <span>Ready for Review</span>
        </span>
      );
  }
};

export default ApplicationStatusBadge;
