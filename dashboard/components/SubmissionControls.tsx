/**
 * @fileoverview Submission & Dry-Run Action Controls (Phase V2-UI).
 *
 * Provides operator action buttons styled after the neo-brutalist job board reference:
 * - Approve & Submit: Coral (#E88474) with dark border & hard shadow
 * - Dry-Run: Soft Sky Blue (#B8D4E8) with dark border & hard shadow
 * - Proof & Screenshot: Crisp white/green cards with dark borders
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
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

  const canSubmit =
    !hasUnresolved &&
    !isApplying &&
    (status === 'READY_FOR_REVIEW' || status === 'DRY_RUN_COMPLETE' || status === 'FAILED');
  const canDryRun = !isApplying && !isDryRunning;

  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      {/* CAPTCHA Resume Button */}
      {isCaptcha && onResumeCaptcha && (
        <button
          type="button"
          onClick={onResumeCaptcha}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-bold text-white bg-[#F59E0B] hover:bg-[#D97706] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all animate-bounce"
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
        title={
          isDryRunning
            ? 'Running dry-run form fill...'
            : 'Launch headful browser preview without submitting'
        }
        className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold font-mono transition-all ${
          canDryRun
            ? 'bg-[#B8D4E8] hover:bg-[#A3C7DF] text-[#1A1A2E] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px]'
            : 'bg-[#E2E8F0] text-[#94A3B8] border border-[#CBD5E1] cursor-not-allowed'
        }`}
      >
        {isDryRunning ? (
          <>
            <span className="w-2.5 h-2.5 border-2 border-[#1A1A2E] border-t-transparent rounded-full animate-spin"></span>
            <span>Dry-Running...</span>
          </>
        ) : (
          <>
            <span>🎬</span>
            <span>Dry-Run (Preview)</span>
          </>
        )}
      </button>

      {/* Submit Button (Primary CTA - Coral #E88474) */}
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
        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-bold font-mono transition-all ${
          canSubmit
            ? 'bg-[#E88474] hover:bg-[#D67161] text-white border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px]'
            : 'bg-[#E2E8F0] text-[#94A3B8] border border-[#CBD5E1] cursor-not-allowed'
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
            <span>🚀</span>
            <span>Approve &amp; Submit</span>
          </>
        )}
      </button>

      {/* View Dry Run Screenshot Button */}
      {dryRunScreenshotUrl && onViewDryRun && (
        <button
          type="button"
          onClick={onViewDryRun}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold text-[#1A1A2E] bg-white hover:bg-[#FAF4EB] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono"
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
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold text-[#1E4620] bg-[#9AC89A] hover:bg-[#88B888] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono"
        >
          <span>📸</span>
          <span>View Web Proof</span>
        </button>
      )}
    </div>
  );
};

export default SubmissionControls;
