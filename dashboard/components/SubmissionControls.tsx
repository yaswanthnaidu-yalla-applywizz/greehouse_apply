/**
 * @fileoverview Submission & Dry-Run Action Controls (Phase V2-UI).
 */

import React, { useState, useEffect } from 'react';
import type { ApplicationStatus } from '../../src/db/applications.js';
import { ProofViewer } from './ProofViewer.js';
import type { EmailProofJson } from './EmailProofRenderer.js';
import { SubmittingSpinner } from './SubmittingSpinner.js';

export interface SubmissionControlsProps {
  applicationId: string;
  jobUrl?: string;
  status: ApplicationStatus | string;
  unresolvedFieldsCount: number;
  proofWebUrl?: string | null;
  proofEmailUrl?: string | null;
  proofEmailJson?: EmailProofJson | null;
  emailProofStatus?: 'pending' | 'captured' | 'timed_out' | null;
  dryRunScreenshotUrl?: string | null;
  proofFailedUrl?: string | null;
  isSubmitting?: boolean;
  isDryRunning?: boolean;
  apiBaseUrl?: string;
  onTriggerDryRun: () => void;
  onTriggerSubmit: () => void;
  onStatusChange?: (newStatus: ApplicationStatus, updatedApp?: any) => void;
  onViewProof?: () => void;
  onViewEmailProof?: () => void;
  onViewDryRun?: () => void;
  onViewFailureScreenshot?: () => void;
}

const SUBMIT_FLOW_STATUSES = new Set(['APPLYING', 'QUEUED', 'OTP_REQUIRED', 'CAPTCHA_REQUIRED']);

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
  proofEmailJson,
  emailProofStatus,
  dryRunScreenshotUrl,
  proofFailedUrl,
  isSubmitting = false,
  isDryRunning = false,
  apiBaseUrl = '',
  onTriggerDryRun,
  onTriggerSubmit,
  onStatusChange,
  onViewProof,
  onViewEmailProof,
  onViewDryRun,
  onViewFailureScreenshot,
}) => {
  const [applicationStatus, setApplicationStatus] = useState<ApplicationStatus | string>(status);
  const [proofUrl, setProofUrl] = useState<string | null>(proofWebUrl || null);
  const [emailProof, setEmailProof] = useState<string | null>(proofEmailUrl || null);
  const [emailProofJsonState, setEmailProofJsonState] = useState<EmailProofJson | null>(
    proofEmailJson || null
  );
  const [showProofViewer, setShowProofViewer] = useState(false);
  const [isCapturingEmailProof, setIsCapturingEmailProof] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    setApplicationStatus(status);
  }, [status]);

  useEffect(() => {
    if (proofWebUrl) {
      setProofUrl(proofWebUrl);
    }
  }, [proofWebUrl]);

  useEffect(() => {
    if (proofEmailUrl) {
      setEmailProof(proofEmailUrl);
    }
  }, [proofEmailUrl]);

  useEffect(() => {
    if (proofEmailJson) {
      setEmailProofJsonState(proofEmailJson);
    }
  }, [proofEmailJson]);

  const hasUnresolved = unresolvedFieldsCount > 0;
  const isApplying =
    isSubmitting || SUBMIT_FLOW_STATUSES.has(String(applicationStatus));
  const isApplied = applicationStatus === 'APPLIED';
  const isFailed = applicationStatus === 'FAILED';
  const hasProofActions =
    Boolean(dryRunScreenshotUrl) ||
    Boolean(proofUrl || proofWebUrl || isApplied) ||
    Boolean(emailProofJsonState || proofEmailJson) ||
    Boolean(emailProof || proofEmailUrl) ||
    Boolean((proofUrl || proofWebUrl) && !(emailProofJsonState || proofEmailJson || emailProof || proofEmailUrl)) ||
    Boolean(isFailed && proofFailedUrl);

  const pollStatusUpdate = async () => {
    try {
      const pollUrl = `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}${jobUrl ? `?jobUrl=${encodeURIComponent(jobUrl)}` : ''}`;
      const res = await fetch(pollUrl, { headers: getAuthHeaders() });
      if (res.ok) {
        const appData = await res.json();
        const resolvedJson = appData.proofEmailJson || appData.proof_email_json || null;
        if (resolvedJson) {
          setEmailProofJsonState(resolvedJson);
        }
        const resolvedEmail = appData.proofEmailUrl || appData.proof_email_url || null;
        if (resolvedEmail) {
          setEmailProof(resolvedEmail);
        }
        if (onStatusChange) {
          onStatusChange((appData.status || applicationStatus) as ApplicationStatus, appData);
        }
      }
    } catch (err) {
      console.warn(`[SubmissionControls] Status poll error for ${applicationId}:`, err);
    }
  };

  useEffect(() => {
    if (applicationStatus !== 'APPLIED' || emailProofStatus !== 'pending' || !applicationId) {
      return;
    }
    const pollInterval = setInterval(() => {
      pollStatusUpdate();
    }, 3000);
    return () => clearInterval(pollInterval);
  }, [applicationStatus, emailProofStatus, applicationId, jobUrl, apiBaseUrl]);

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
      const capturedJson = data.proofEmailJson || data.proof_email_json;
      if (res.ok && data.success && capturedJson) {
        setEmailProofJsonState(capturedJson);
        setToastMessage('🎉 Confirmation email proof captured!');
        setTimeout(() => setToastMessage(null), 6000);
        if (onStatusChange) {
          onStatusChange('APPLIED', {
            ...data,
            proof_email_json: capturedJson,
            proofEmailJson: capturedJson,
            proof_email_captured_at: data.proofEmailCapturedAt,
            proofEmailCapturedAt: data.proofEmailCapturedAt,
            email_proof_status: 'captured',
            emailProofStatus: 'captured',
          });
        }
        if (onViewEmailProof) {
          onViewEmailProof();
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

      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-[110] bg-[#9AC89A] border-2 border-[#1A1A2E] text-[#1E4620] px-4 py-3 rounded-lg font-bold shadow-[4px_4px_0px_#1A1A2E] flex items-center gap-2 animate-bounce">
          <span>{toastMessage}</span>
        </div>
      )}

      <div className="flex flex-col items-end gap-2.5 w-full min-w-[200px]">
        {applicationStatus === 'QUEUED' ? (
          <SubmittingSpinner text="Queued for worker..." className="w-full" />
        ) : isApplying ? (
          <SubmittingSpinner text="Submitting..." className="w-full" />
        ) : null}

        <div className="flex items-center gap-2.5 flex-wrap justify-end">
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

          <button
            type="button"
            onClick={onTriggerSubmit}
            disabled={!canSubmit}
            title={
              hasUnresolved
                ? `Cannot submit: ${unresolvedFieldsCount} unresolved field(s) require review`
                : applicationStatus === 'QUEUED'
                ? 'Application queued for worker...'
                : isApplying
                ? 'Submission in progress...'
                : isApplied
                ? 'Application already submitted and verified'
                : 'Submit verified application via automated flow'
            }
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-bold font-mono transition-all ${
              canSubmit
                ? 'bg-[#E88474] hover:bg-[#D67161] text-white border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px]'
                : 'bg-[#E2E8F0] text-[#94A3B8] border border-[#CBD5E1] cursor-not-allowed'
            }`}
          >
            {applicationStatus === 'QUEUED' ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                <span>Queued...</span>
              </>
            ) : isApplying ? (
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

          {hasProofActions && (
            <div className="flex flex-wrap items-center justify-end gap-1.5 w-full pt-0.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#64748B] font-mono w-full text-right">
                Proofs
              </span>
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

              {(proofUrl || proofWebUrl) &&
                !(emailProofJsonState || proofEmailJson || emailProof || proofEmailUrl) && (
                  <button
                    type="button"
                    onClick={handleCaptureEmailProof}
                    disabled={isCapturingEmailProof}
                    title="Capture confirmation email proof from candidate inbox"
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
                        <span>Fetch email proof</span>
                      </>
                    )}
                  </button>
                )}

              {(emailProofJsonState || proofEmailJson || emailProof || proofEmailUrl) && (
                <button
                  type="button"
                  onClick={() => {
                    if (onViewEmailProof) {
                      onViewEmailProof();
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold text-[#1E3A8A] bg-[#BFDBFE] hover:bg-[#93C5FD] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono"
                >
                  <span>📧</span>
                  <span>View Email Proof</span>
                </button>
              )}

              {isFailed && proofFailedUrl && onViewFailureScreenshot && (
                <button
                  type="button"
                  onClick={onViewFailureScreenshot}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold text-[#7F1D1D] bg-[#FECACA] hover:bg-[#FCA5A5] border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all font-mono"
                >
                  <span>🛑</span>
                  <span>View Failure Screenshot</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default SubmissionControls;
