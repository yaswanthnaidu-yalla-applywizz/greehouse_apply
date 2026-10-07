/**
 * @fileoverview Submission & Dry-Run Action Controls (Phase V2-UI).
 */

import React, { useState, useEffect } from 'react';
import type { ApplicationStatus } from '../../src/db/applications.js';
import { ProofViewer } from './ProofViewer.js';
import type { EmailProofJson } from './EmailProofRenderer.js';
import { SubmittingSpinner } from './SubmittingSpinner.js';
import { apiFetch } from '../hooks/useSession.js';

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
  retryCount?: number | null;
  questionLimitBlocked?: boolean;
  isSubmitting?: boolean;
  isDryRunning?: boolean;
  apiBaseUrl?: string;
  onTriggerDryRun: () => void;
  onTriggerSubmit: () => void;
  onStatusChange?: (
    newStatus: ApplicationStatus,
    updatedApp?: any,
    options?: { persist?: boolean }
  ) => void;
  onViewProof?: () => void;
  onViewEmailProof?: (proof?: EmailProofJson) => void;
  onViewDryRun?: () => void;
  onViewFailureScreenshot?: () => void;
}

const SUBMIT_FLOW_STATUSES = new Set(['APPLYING', 'QUEUED', 'OTP_REQUIRED', 'CAPTCHA_REQUIRED']);

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
  retryCount = 0,
  questionLimitBlocked = false,
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
  const [isRetrying, setIsRetrying] = useState(false);

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
  const isFailed = applicationStatus === 'FAILED' || applicationStatus === 'RETRY';
  const isEmailProofPending = applicationStatus === 'EMAIL_PROOF_PENDING' || status === 'EMAIL_PROOF_PENDING';
  const hasProofActions =
    Boolean(dryRunScreenshotUrl) ||
    Boolean(proofUrl || proofWebUrl || isApplied || isEmailProofPending) ||
    Boolean(emailProofJsonState || proofEmailJson) ||
    Boolean(emailProof || proofEmailUrl) ||
    Boolean(isEmailProofPending) ||
    Boolean((proofUrl || proofWebUrl) && !(emailProofJsonState || proofEmailJson || emailProof || proofEmailUrl)) ||
    Boolean(isFailed && proofFailedUrl);

  const pollStatusUpdate = async () => {
    try {
      const pollUrl = `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}${jobUrl ? `?jobUrl=${encodeURIComponent(jobUrl)}` : ''}`;
      const res = await apiFetch(pollUrl);
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
          onStatusChange((appData.status || applicationStatus) as ApplicationStatus, appData, {
            persist: false,
          });
        }
      }
    } catch (err) {
      console.warn(`[SubmissionControls] Status poll error for ${applicationId}:`, err);
    }
  };

  useEffect(() => {
    if (
      (applicationStatus !== 'APPLIED' && applicationStatus !== 'EMAIL_PROOF_PENDING') ||
      emailProofStatus !== 'pending' ||
      !applicationId
    ) {
      return;
    }
    const pollInterval = setInterval(() => {
      pollStatusUpdate();
    }, 3000);
    return () => clearInterval(pollInterval);
  }, [applicationStatus, emailProofStatus, applicationId, jobUrl, apiBaseUrl]);

  const captureEmailProof = async () => {
    setIsCapturingEmailProof(true);
    try {
      const res = await apiFetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}/capture-email-proof`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
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
          onViewEmailProof(capturedJson);
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
    applicationStatus === 'FAILED' ||
    applicationStatus === 'RETRY');
  const canDryRun = !isApplying && !isDryRunning;
  const canRetry = isFailed && !questionLimitBlocked && Number(retryCount || 0) < 3;

  const retrySubmission = async () => {
    if (!canRetry || isRetrying) return;
    setIsRetrying(true);
    try {
      const res = await apiFetch(`${apiBaseUrl}/api/applications/${encodeURIComponent(applicationId)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToastMessage(data.error || 'Retry request failed.');
        setTimeout(() => setToastMessage(null), 6000);
        return;
      }
      onStatusChange?.('QUEUED', { status: 'QUEUED', error_message: null }, { persist: false });
    } catch (err: any) {
      setToastMessage(err.message || 'Retry request failed.');
      setTimeout(() => setToastMessage(null), 6000);
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <>
      {showProofViewer && (proofUrl || applicationId) && (
        <ProofViewer
          isOpen={showProofViewer}
          onClose={() => setShowProofViewer(false)}
          screenshotUrl={proofUrl}
          applicationId={applicationId}
          kind="web"
          apiBaseUrl={apiBaseUrl}
          title="Application Confirmation Proof"
          metadata={{
            applywizzId: applicationId,
            jobUrl,
            status: 'APPLIED',
          }}
        />
      )}

      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-[110] bg-[#1c1c1e] border border-[#30d158]/50 text-[#30d158] px-4 py-3 rounded-xl font-bold flex items-center gap-2">
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
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold font-mono transition-all ${
              canDryRun
                ? 'bg-[#2c2c2e] hover:bg-[#3a3a3c] text-[#ffffff] border border-[#3a3a3c]'
                : 'bg-[#1c1c1e] text-[#8e8e93]/50 border border-[#2c2c2e] cursor-not-allowed'
            }`}
          >
            {isDryRunning ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-[#ffffff] border-t-transparent rounded-full animate-spin"></span>
                <span>Dry-Running...</span>
              </>
            ) : (
              <>
                <span>🎬</span>
                <span>Dry-Run (Preview)</span>
              </>
            )}
          </button>

          {canRetry && (
            <button
              type="button"
              onClick={retrySubmission}
              disabled={isRetrying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold font-mono text-[#ff9f0a] bg-[#ff9f0a]/15 hover:bg-[#ff9f0a]/25 border border-[#ff9f0a]/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRetrying ? 'Retrying...' : '↺ Retry Submission'}
            </button>
          )}

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
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold font-mono transition-all ${
              canSubmit
                ? 'bg-[#30d158] hover:bg-[#28b84d] text-[#000000] border border-[#30d158]'
                : 'bg-[#1c1c1e] text-[#8e8e93]/50 border border-[#2c2c2e] cursor-not-allowed'
            }`}
          >
            {applicationStatus === 'QUEUED' ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-[#000000] border-t-transparent rounded-full animate-spin"></span>
                <span>Queued...</span>
              </>
            ) : isApplying ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-[#000000] border-t-transparent rounded-full animate-spin"></span>
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
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93] font-mono w-full text-right">
                Proofs
              </span>
              {dryRunScreenshotUrl && onViewDryRun && (
                <button
                  type="button"
                  onClick={onViewDryRun}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-[#ffffff] bg-[#1c1c1e] hover:bg-[#2c2c2e] border border-[#2c2c2e] transition-all font-mono"
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
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#30d158] bg-[#30d158]/15 hover:bg-[#30d158]/25 border border-[#30d158]/30 transition-all font-mono"
                >
                  <span>📸</span>
                  <span>View Web Proof</span>
                </button>
              )}

              {(isEmailProofPending || Boolean(proofUrl || proofWebUrl)) &&
                !(emailProofJsonState || proofEmailJson || emailProof || proofEmailUrl) && (
                  <button
                    type="button"
                    onClick={captureEmailProof}
                    disabled={isCapturingEmailProof}
                    title="Capture confirmation email proof from candidate inbox"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#0a84ff] bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/30 transition-all font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isCapturingEmailProof ? (
                      <>
                        <span className="w-2.5 h-2.5 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin"></span>
                        <span>Capturing Email Proof...</span>
                      </>
                    ) : (
                      <>
                        <span>📧</span>
                        <span>Capture Email Proof</span>
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
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#0a84ff] bg-[#0a84ff]/15 hover:bg-[#0a84ff]/25 border border-[#0a84ff]/30 transition-all font-mono"
                >
                  <span>📧</span>
                  <span>View Email Proof</span>
                </button>
              )}

              {isFailed && proofFailedUrl && onViewFailureScreenshot && (
                <button
                  type="button"
                  onClick={onViewFailureScreenshot}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-[#ff453a] bg-[#ff453a]/15 hover:bg-[#ff453a]/25 border border-[#ff453a]/30 transition-all font-mono"
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
