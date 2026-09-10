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

import React, { useState, useEffect } from 'react';
import type { ApplicationStatus } from '../../src/db/applications.js';
import { ProofViewer } from './ProofViewer.js';

export interface SubmissionControlsProps {
  applicationId: string;
  jobUrl?: string;
  status: ApplicationStatus | string;
  unresolvedFieldsCount: number;
  proofWebUrl?: string | null;
  proofEmailUrl?: string | null;
  emailProofStatus?: 'pending' | 'captured' | 'timed_out' | null;
  dryRunScreenshotUrl?: string | null;
  isSubmitting?: boolean;
  isDryRunning?: boolean;
  apiBaseUrl?: string;
  onTriggerDryRun: () => void;
  onTriggerSubmit: () => void;
  onStatusChange?: (newStatus: ApplicationStatus, updatedApp?: any) => void;
  onOtpVerified?: (payload: { proofWebUrl?: string; proofCapturedAt?: string }) => void;
  onViewProof?: () => void;
  onViewEmailProof?: () => void;
  onViewDryRun?: () => void;
}

const getAuthHeaders = (): Record<string, string> => {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const SubmissionControls: React.FC<SubmissionControlsProps> = ({
  applicationId,
  jobUrl = '',
  status,
  unresolvedFieldsCount,
  proofWebUrl,
  proofEmailUrl,
  emailProofStatus,
  dryRunScreenshotUrl,
  isSubmitting = false,
  isDryRunning = false,
  apiBaseUrl = '',
  onTriggerDryRun,
  onTriggerSubmit,
  onStatusChange,
  onOtpVerified,
  onViewProof,
  onViewEmailProof,
  onViewDryRun,
}) => {
  const [applicationStatus, setApplicationStatus] = useState<ApplicationStatus | string>(status);
  const [otpValue, setOtpValue] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [proofUrl, setProofUrl] = useState<string | null>(proofWebUrl || null);
  const [emailProof, setEmailProof] = useState<string | null>(proofEmailUrl || null);
  const [showProofViewer, setShowProofViewer] = useState(false);
  const [isCapturingEmailProof, setIsCapturingEmailProof] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    setApplicationStatus(status);
    if (status === 'OTP_REQUIRED') {
      setOtpError(null);
    }
  }, [status]);

  useEffect(() => {
    if (proofWebUrl) {
      setProofUrl(proofWebUrl);
    }
  }, [proofWebUrl]);

  const hasUnresolved = unresolvedFieldsCount > 0;
  const isApplying = applicationStatus === 'APPLYING' || isSubmitting;
  const isApplied = applicationStatus === 'APPLIED';
  const isOtp = applicationStatus === 'OTP_REQUIRED';

  const pollStatusUpdate = async () => {
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const appData = await res.json();
        if (appData.status && onStatusChange) {
          onStatusChange(appData.status as ApplicationStatus, appData);
        }
      }
    } catch (err) {
      console.warn(`[SubmissionControls] Status poll error for ${applicationId}:`, err);
    }
  };

  const handleVerifyOtp = async () => {
    const cleanOtp = otpValue.trim();
    if (!cleanOtp) {
      setOtpError('Please enter the OTP code.');
      return;
    }

    setOtpLoading(true);
    setOtpError(null);
    setApplicationStatus('APPLYING');
    if (onStatusChange) {
      onStatusChange('APPLYING');
    }

    try {
      const res = await fetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}/submit-otp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ otp: cleanOtp, jobUrl: jobUrl || undefined }),
        }
      );
      const data = await res.json();
      const resolvedProofUrl = data.proofUrl || data.proofWebUrl;
      const proofCapturedAt = data.proofCapturedAt;

      if (!res.ok || data.status !== 'APPLIED') {
        setOtpError(data.error || 'OTP verification failed.');
        setApplicationStatus('OTP_REQUIRED');
        await pollStatusUpdate();
        return;
      }

      setApplicationStatus('APPLIED');
      setProofUrl(resolvedProofUrl);
      setShowOtpModal(false);
      setShowProofViewer(true);
      setOtpValue('');
      setToastMessage('🎉 Application submitted! Proof captured.');
      setTimeout(() => setToastMessage(null), 6000);

      if (onStatusChange) {
        onStatusChange('APPLIED', {
          ...data,
          proofWebUrl: resolvedProofUrl,
          proof_web_url: resolvedProofUrl,
          proofCapturedAt,
          proof_captured_at: proofCapturedAt,
        });
      }

      if (onOtpVerified) {
        onOtpVerified({ proofWebUrl: resolvedProofUrl, proofCapturedAt });
      } else if (resolvedProofUrl && onViewProof) {
        onViewProof();
      }
    } catch (err: any) {
      console.error('OTP verification failed:', err);
      setOtpError(err.message || 'OTP verification failed.');
      setApplicationStatus('OTP_REQUIRED');
      await pollStatusUpdate();
    } finally {
      setOtpLoading(false);
    }
  };

  const handleCaptureEmailProof = async () => {
    setIsCapturingEmailProof(true);
    try {
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
      const res = await fetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}/capture-email-proof`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ jobUrl: jobUrl || undefined }),
        }
      );
      const data = await res.json();
      if (res.ok && data.success && data.proofEmailUrl) {
        setEmailProof(data.proofEmailUrl);
        setToastMessage('🎉 Confirmation email proof screenshot captured!');
        setTimeout(() => setToastMessage(null), 6000);
        if (onStatusChange) {
          onStatusChange('APPLIED', {
            ...data,
            proof_email_url: data.proofEmailUrl,
            proofEmailUrl: data.proofEmailUrl,
            proof_email_captured_at: data.proofEmailCapturedAt,
            proofEmailCapturedAt: data.proofEmailCapturedAt,
            email_proof_status: 'captured',
            emailProofStatus: 'captured',
          });
        }
      } else {
        setToastMessage(data.error || 'Confirmation email not found in inbox yet. Please try again in a moment.');
        setTimeout(() => setToastMessage(null), 6000);
        await pollStatusUpdate();
      }
    } catch (err: any) {
      console.error('Capture email proof failed:', err);
      setToastMessage(`Capture email proof: ${err.message}`);
      setTimeout(() => setToastMessage(null), 6000);
    } finally {
      setIsCapturingEmailProof(false);
    }
  };

  const canSubmit =
    !hasUnresolved &&
    !isApplying &&
    (applicationStatus === 'READY_FOR_REVIEW' ||
      applicationStatus === 'DRY_RUN_COMPLETE' ||
      applicationStatus === 'FAILED');
  const canDryRun = !isApplying && !isDryRunning;

  return (
    <>
      {/* OTP Entry Modal */}
      {isOtp && showOtpModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#1A1A2E]/50 p-4">
          <div
            className="bg-white border-2 border-[#1A1A2E] rounded-xl p-6 w-full max-w-md shadow-[6px_6px_0px_#1A1A2E]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="otp-modal-title"
          >
            <div className="flex items-center justify-between mb-2">
              <h2
                id="otp-modal-title"
                className="text-lg font-bold text-[#1A1A2E] flex items-center gap-2"
              >
                <span>🔐</span>
                <span>Enter OTP</span>
              </h2>
              <button
                type="button"
                onClick={() => setShowOtpModal(false)}
                className="text-[#64748B] hover:text-[#1A1A2E] text-sm font-bold px-1.5 py-0.5 rounded"
                title="Close modal"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-[#64748B] mb-4 font-medium">
              A verification code was sent after submission. Enter it below to complete the
              application.
            </p>
            {otpError && (
              <div className="mb-3 px-3 py-2 bg-[#FEE2E2] border border-[#EF4444] rounded text-xs text-[#991B1B] font-semibold flex items-center gap-2">
                <span>⚠️</span>
                <span>{otpError}</span>
              </div>
            )}
            <input
              type="text"
              inputMode="text"
              maxLength={16}
              autoComplete="one-time-code"
              placeholder="Enter OTP code (e.g. Aebf0aDc)"
              value={otpValue}
              disabled={otpLoading}
              onChange={(e) => {
                setOtpValue(e.target.value);
                if (otpError) setOtpError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !otpLoading) {
                  handleVerifyOtp();
                }
              }}
              className="w-full px-3 py-2.5 mb-4 rounded-md border-2 border-[#1A1A2E] text-sm font-mono text-[#1A1A2E] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#F59E0B] disabled:opacity-60"
            />
            {otpValue.trim() && (
              <button
                type="button"
                onClick={handleVerifyOtp}
                disabled={otpLoading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-bold text-white bg-[#F59E0B] hover:bg-[#D97706] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {otpLoading ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    <span>Submitting &amp; Resuming...</span>
                  </>
                ) : (
                  <span>Submit OTP &amp; Resume Application</span>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Proof Viewer Modal */}
      {showProofViewer && proofUrl && (
        <ProofViewer
          isOpen={showProofViewer}
          onClose={() => setShowProofViewer(false)}
          screenshotUrl={proofUrl}
          title="Application Confirmation Proof"
          metadata={{
            applywizzId: applicationId,
            jobUrl,
            status: 'APPLIED',
          }}
        />
      )}

      {/* Success Toast */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-[110] bg-[#9AC89A] border-2 border-[#1A1A2E] text-[#1E4620] px-4 py-3 rounded-lg font-bold shadow-[4px_4px_0px_#1A1A2E] flex items-center gap-2 animate-bounce">
          <span>{toastMessage}</span>
        </div>
      )}

      <div className="flex items-center gap-2.5 flex-wrap">
      {/* CAPTCHA / OTP Action Button */}
      {isOtp && !showOtpModal && (
        <button
          type="button"
          onClick={() => setShowOtpModal(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-bold text-[#451A03] bg-[#F59E0B] hover:bg-[#D97706] border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
        >
          <span>🔐</span>
          <span>OTP Required — Enter OTP</span>
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
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold font-mono transition-all ${
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
        className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-bold font-mono transition-all ${
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
      {(proofUrl || isApplied) && (
        <button
          type="button"
          onClick={() => {
            if (onViewProof) {
              onViewProof();
            } else if (proofUrl) {
              setShowProofViewer(true);
            }
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold text-[#1E4620] bg-[#9AC89A] hover:bg-[#88B888] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono"
        >
          <span>📸</span>
          <span>View Web Proof</span>
        </button>
      )}

      {/* Get Email SS Button (Manual retry when web proof is present but email proof is missing) */}
      {(proofUrl || proofWebUrl) && !(emailProof || proofEmailUrl) && (
        <button
          type="button"
          onClick={handleCaptureEmailProof}
          disabled={isCapturingEmailProof}
          title="Capture confirmation email screenshot proof from candidate inbox"
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold text-[#1E3A8A] bg-[#DBEAFE] hover:bg-[#BFDBFE] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isCapturingEmailProof ? (
            <>
              <span className="w-2.5 h-2.5 border-2 border-[#1E3A8A] border-t-transparent rounded-full animate-spin"></span>
              <span>Fetching Email SS...</span>
            </>
          ) : (
            <>
              <span>📥</span>
              <span>Get email SS</span>
            </>
          )}
        </button>
      )}

      {/* View Email Proof Button */}
      {(emailProof || proofEmailUrl) && (
        <button
          type="button"
          onClick={() => {
            if (onViewEmailProof) {
              onViewEmailProof();
            } else if (emailProof || proofEmailUrl) {
              setProofUrl(emailProof || proofEmailUrl);
              setShowProofViewer(true);
            }
          }}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold text-[#1E3A8A] bg-[#BFDBFE] hover:bg-[#93C5FD] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono"
        >
          <span>📧</span>
          <span>View Email Proof</span>
        </button>
      )}
      </div>
    </>
  );
};

export default SubmissionControls;
