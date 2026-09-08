/**
 * @fileoverview Submission & Dry-Run Action Controls (Phase V2-5).
 *
 * Provides operator action buttons for Dry-Run, Live Submission, CAPTCHA Resumption,
 * and Verification Proof inspection.
 *
 * References:
 * - 04-ui-ux.md
 * - V2-implementation.md (Phase V2-5)
 */

import React from 'react';
import type { ApplicationStatus } from '../../src/db/applications.js';

export interface SubmissionControlsProps {
  applicationId: string;
  status: ApplicationStatus | string;
  unresolvedFieldsCount: number;
  proofWebUrl?: string | null;
  dryRunScreenshotUrl?: string | null;
  isSubmitting?: boolean;
  isDryRunning?: boolean;
  onTriggerDryRun: () => void;
  onTriggerSubmit: () => void;
  onResumeCaptcha?: () => void;
  onViewProof?: () => void;
  onViewDryRun?: () => void;
}

export const SubmissionControls: React.FC<SubmissionControlsProps> = ({
  applicationId,
  status,
  unresolvedFieldsCount,
  proofWebUrl,
  dryRunScreenshotUrl,
  isSubmitting = false,
  isDryRunning = false,
  onTriggerDryRun,
  onTriggerSubmit,
  onResumeCaptcha,
  onViewProof,
  onViewDryRun,
}) => {
  const hasUnresolved = unresolvedFieldsCount > 0;
  const isApplying = status === 'APPLYING' || isSubmitting;
  const isApplied = status === 'APPLIED';
  const isCaptcha = status === 'CAPTCHA_REQUIRED';

  const canSubmit = !hasUnresolved && !isApplying && (status === 'READY_FOR_REVIEW' || status === 'DRY_RUN_COMPLETE' || status === 'FAILED');
  const canDryRun = !isApplying && !isDryRunning;

  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      {/* CAPTCHA Resume Button */}
      {isCaptcha && onResumeCaptcha && (
        <button
          type="button"
          onClick={onResumeCaptcha}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-orange-600 hover:bg-orange-700 shadow-md hover:shadow-lg transition-all animate-bounce"
        >
          <span>🔓</span>
          <span>I Solved CAPTCHA — Resume Submission</span>
        </button>
      )}

      {/* Dry-Run Button */}
      <button
        type="button"
        onClick={onTriggerDryRun}
        disabled={!canDryRun}
        title={isDryRunning ? 'Running dry-run form fill...' : 'Launch headful browser preview without submitting'}
        className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold font-mono transition-all ${
          canDryRun
            ? 'bg-[#FFFFFF] hover:bg-[#F8F3ED] text-[#1E293B] border border-[#D8C7B5] shadow-sm hover:border-[#1A1A2E]'
            : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
        }`}
      >
        {isDryRunning ? (
          <>
            <span className="w-2.5 h-2.5 border-2 border-slate-600 border-t-transparent rounded-full animate-spin"></span>
            <span>Dry-Running...</span>
          </>
        ) : (
          <>
            <span>🚀</span>
            <span>Dry-Run (Preview)</span>
          </>
        )}
      </button>

      {/* Submit Button */}
      <button
        type="button"
        onClick={onTriggerSubmit}
        disabled={!canSubmit}
        title={
          hasUnresolved
            ? `Cannot submit: ${unresolvedFieldsCount} unresolved field(s) require review`
            : isApplying
            ? 'Submission in progress...'
            : isApplied
            ? 'Application already submitted and verified'
            : 'Submit verified application via headless Playwright engine'
        }
        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold font-mono transition-all shadow-sm ${
          canSubmit
            ? 'bg-[#059669] hover:bg-[#047857] text-white shadow-emerald-900/20 hover:shadow-md'
            : 'bg-slate-200 text-slate-400 cursor-not-allowed border border-slate-300'
        }`}
      >
        {isApplying ? (
          <>
            <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
            <span>Submitting...</span>
          </>
        ) : isApplied ? (
          <>
            <span>✅</span>
            <span>Applied &amp; Verified</span>
          </>
        ) : (
          <>
            <span>⚡</span>
            <span>Approve &amp; Submit</span>
          </>
        )}
      </button>

      {/* View Dry Run Screenshot Button */}
      {dryRunScreenshotUrl && onViewDryRun && (
        <button
          type="button"
          onClick={onViewDryRun}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-sky-800 bg-sky-50 hover:bg-sky-100 border border-sky-300 shadow-sm transition-colors font-mono"
        >
          <span>🖼️</span>
          <span>Dry-Run Screenshot</span>
        </button>
      )}

      {/* View Web Proof Button */}
      {(proofWebUrl || isApplied) && onViewProof && (
        <button
          type="button"
          onClick={onViewProof}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-emerald-900 bg-emerald-100 hover:bg-emerald-200 border border-emerald-400 shadow-sm transition-colors font-mono"
        >
          <span>📸</span>
          <span>View Web Proof</span>
        </button>
      )}
    </div>
  );
};

export default SubmissionControls;
