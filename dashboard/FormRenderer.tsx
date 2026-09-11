/**
 * @fileoverview Right Pane Main: Dynamic Form Renderer with Submission Controls & Proof Viewer (Phase V2-UI).
 *
 * Renders form fields, source attribution breakdown, and live submission controls
 * using the neo-brutalist job board aesthetic.
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
 */

import React, { useState, useEffect } from 'react';
import { EditableFormField } from './components/EditableFormField.js';
import { SourceBadge } from './components/SourceBadge.js';
import { ApplicationStatusBadge } from './components/ApplicationStatusBadge.js';
import { DifficultyBadge } from './components/DifficultyBadge.js';
import { SubmissionControls } from './components/SubmissionControls.js';
import { ProofViewer } from './components/ProofViewer.js';
import { EmailProofModal } from './components/EmailProofModal.js';
import type { EmailProofJson } from './components/EmailProofRenderer.js';
import type { ResolvedField, ApplicationStatus } from './types.js';

export { SourceBadge, ApplicationStatusBadge, DifficultyBadge, SubmissionControls, ProofViewer };

export interface FormRendererProps {
  /** Resolved candidate job application payload */
  application: any | null;
  /** Loading state */
  isLoading?: boolean;
  /** Candidate client name for metadata */
  candidateName?: string;
  /** API Base URL */
  apiBaseUrl?: string;
  /** Callback fired when an operator manually modifies a field */
  onFieldUpdate?: (updatedField: ResolvedField) => void;
  /** Callback fired when status transitions (e.g. from polling or submission) */
  onStatusChange?: (newStatus: ApplicationStatus, updatedApp?: any) => void;
}

export const FormRenderer: React.FC<FormRendererProps> = ({
  application,
  isLoading = false,
  candidateName,
  apiBaseUrl = '',
  onFieldUpdate,
  onStatusChange,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDryRunning, setIsDryRunning] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);
  const [viewerTitle, setViewerTitle] = useState<string>('Application Proof');
  const [emailProofOpen, setEmailProofOpen] = useState(false);
  const appId = application?.id || application?.applywizzId || application?.applywizz_id || 'app-default';
  const jobUrl = application?.jobUrl || application?.job_url || '';
  const storageKey = `greenhouse_approvals_${appId}_${typeof btoa !== 'undefined' ? btoa(encodeURIComponent(jobUrl || 'default')).slice(0, 32) : 'default'}`;

  const getStoredApprovals = (key: string): Set<string> => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return new Set(parsed);
      }
    } catch {}
    return new Set<string>();
  };

  const [carouselIndex, setCarouselIndex] = useState<number>(0);
  const [approvedFieldIds, setApprovedFieldIds] = useState<Set<string>>(() => getStoredApprovals(storageKey));
  const [viewMode, setViewMode] = useState<'carousel' | 'list'>('carousel');
  const [filterActionableOnly, setFilterActionableOnly] = useState<boolean>(false);

  useEffect(() => {
    setCarouselIndex(0);
    setApprovedFieldIds(getStoredApprovals(storageKey));
  }, [appId, jobUrl, storageKey]);

  const saveApprovedFields = (nextSet: Set<string>) => {
    setApprovedFieldIds(nextSet);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, JSON.stringify(Array.from(nextSet)));
      }
    } catch {}
  };

  const persistApproval = async (fieldsToPersist?: ResolvedField[]) => {
    try {
      const targetFields = fieldsToPersist || fields;
      const targetAppId = application?.id || application?.applywizzId || application?.applywizz_id || appId;
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      await fetch(`${apiBaseUrl}/api/applications/${encodeURIComponent(targetAppId)}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobUrl,
          resolved_fields: targetFields,
          companyName: application?.companyName || application?.company_name,
          jobTitle: application?.jobTitle || application?.job_title,
          status: application?.status || 'READY_FOR_REVIEW',
        }),
      });
    } catch (e) {
      console.warn('[FormRenderer] Could not persist approval to server:', e);
    }
  };

  const fields: ResolvedField[] = application?.resolvedFields || application?.resolved_fields || [];
  const manualCount = fields.filter((f) => f.isEdited || f.source === 'manual').length;
  const supabaseCount = fields.filter((f) => f.source === 'supabase' && !f.isEdited).length;
  const aiCount = fields.filter((f) => f.source === 'ai' && !f.isEdited).length;
  const unresCount = fields.filter((f) => f.source === 'unresolved').length;

  const currentStatus: ApplicationStatus = application?.status || 'READY_FOR_REVIEW';
  const submitFlowActive =
    isSubmitting ||
    currentStatus === 'APPLYING' ||
    currentStatus === 'QUEUED' ||
    currentStatus === 'OTP_REQUIRED' ||
    currentStatus === 'CAPTCHA_REQUIRED';
  const badgeStatus: ApplicationStatus | string =
    currentStatus === 'QUEUED' ||
    currentStatus === 'OTP_REQUIRED' ||
    currentStatus === 'CAPTCHA_REQUIRED'
      ? 'APPLYING'
      : currentStatus;

  useEffect(() => {
    if (currentStatus === 'APPLIED' || currentStatus === 'FAILED') {
      setIsSubmitting(false);
    }
  }, [currentStatus]);

  const isDemographic = (label: string) => {
    const l = (label || '').toLowerCase();
    return (
      l.includes('gender') ||
      l.includes('race') ||
      l.includes('ethnicity') ||
      l.includes('veteran') ||
      l.includes('disability')
    );
  };

  const actionableFields = fields.filter(
    (f) => !isDemographic(f.label) || f.source === 'ai' || f.source === 'unresolved'
  );

  const displayFields = filterActionableOnly && actionableFields.length > 0
    ? actionableFields
    : fields;

  const boundedIndex = Math.min(Math.max(0, carouselIndex), Math.max(0, displayFields.length - 1));
  const currentField = displayFields[boundedIndex];

  const handleApproveAndNext = () => {
    if (currentField) {
      const next = new Set([...approvedFieldIds, currentField.fieldId]);
      saveApprovedFields(next);
      persistApproval();
    }
    if (boundedIndex < displayFields.length - 1) {
      setCarouselIndex((prev) => prev + 1);
    }
  };

  const handleApproveAll = () => {
    const next = new Set(displayFields.map((f) => f.fieldId));
    saveApprovedFields(next);
    persistApproval();
    setCarouselIndex(Math.max(0, displayFields.length - 1));
  };

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter approves current card and advances
  useEffect(() => {
    if (!application || isLoading) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleApproveAndNext();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [boundedIndex, displayFields, currentField, application, isLoading]);

  if (isLoading) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-[#64748B]">
        <div className="w-8 h-8 border-2 border-[#1A1A2E] border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-xs font-mono font-bold text-[#1A1A2E]">Loading application form...</p>
      </div>
    );
  }

  if (!application) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-[#64748B]">
        <div className="text-4xl mb-3">📋</div>
        <p className="text-sm font-bold text-[#1A1A2E]">No Job Selected</p>
        <p className="text-xs text-[#64748B] mt-1 font-medium">
          Select a candidate from the left directory and click a job tab above to review and submit.
        </p>
      </div>
    );
  }

  const getAuthHeaders = (): Record<string, string> => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const resolveProofFromSubmitResponse = async (data: any) => {
    let proofWebUrl = data.proofWebUrl;
    let proofCapturedAt = data.proofCapturedAt;

    if (data.status === 'APPLIED' && !proofWebUrl) {
      try {
        const proofRes = await fetch(
          `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/proof`,
          { headers: getAuthHeaders() }
        );
        if (proofRes.ok) {
          const proofData = await proofRes.json();
          proofWebUrl = proofData.proofWebUrl;
          proofCapturedAt = proofData.proofCapturedAt;
        }
      } catch {}
    }

    return { proofWebUrl, proofCapturedAt };
  };

  const handleTriggerDryRun = async () => {
    setIsDryRunning(true);
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/dry-run`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ headless: false, jobUrl: jobUrl || undefined }),
        }
      );
      const data = await res.json();
      if (data.screenshotUrl) {
        setViewerImageUrl(data.screenshotUrl);
        setViewerTitle('Dry-Run Form Verification Screenshot');
        setViewerOpen(true);
      }
      if (onStatusChange) {
        onStatusChange('DRY_RUN_COMPLETE', data);
      }
    } catch (err: any) {
      console.error('Dry run failed:', err);
      alert(`Dry run failed: ${err.message}`);
    } finally {
      setIsDryRunning(false);
    }
  };

  const handleTriggerSubmit = async () => {
    if (isSubmitting || submitFlowActive) return;

    console.log(`[Dashboard] Operator submitted ${appId} → auto-flow started`);
    setIsSubmitting(true);
    if (onStatusChange) {
      onStatusChange('APPLYING');
    }
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ headless: true, jobUrl: jobUrl || undefined }),
        }
      );
      const data = await res.json();

      if (!res.ok || data.status === 'FAILED') {
        if (onStatusChange) {
          onStatusChange('FAILED', {
            ...data,
            error: data.error || data.error_message || 'Submit request failed',
          });
        }
        setIsSubmitting(false);
        return;
      }

      if (data.status === 'APPLIED') {
        const { proofWebUrl, proofCapturedAt } = await resolveProofFromSubmitResponse(data);
        if (onStatusChange) {
          onStatusChange('APPLIED', { ...data, proofWebUrl, proofCapturedAt });
        }
        if (proofWebUrl) {
          setViewerImageUrl(proofWebUrl);
          setViewerTitle('Live Application Confirmation Proof');
          setViewerOpen(true);
        }
        setIsSubmitting(false);
        return;
      }

      if (onStatusChange) {
        onStatusChange('APPLYING', data);
      }
    } catch (err: any) {
      console.error('Submission failed:', err);
      if (onStatusChange) {
        onStatusChange('FAILED', { error: err.message });
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-5 py-3.5 md:px-7 md:py-4 max-w-5xl mx-auto w-full custom-scrollbar">
      {/* Proof Viewer Modal */}
      <EmailProofModal
        isOpen={emailProofOpen}
        onClose={() => setEmailProofOpen(false)}
        proof={(application.proof_email_json || application.proofEmailJson) as EmailProofJson | null}
        companyName={application.companyName || application.company_name}
        metadata={{
          candidateName: candidateName || application.clientName,
          applywizzId: application.applywizzId || application.applywizz_id,
          jobTitle: application.jobTitle || application.job_title,
        }}
      />

      <ProofViewer
        isOpen={viewerOpen}
        onClose={() => setViewerOpen(false)}
        screenshotUrl={viewerImageUrl}
        title={viewerTitle}
        metadata={{
          candidateName: candidateName || application.clientName,
          applywizzId: application.applywizzId || application.applywizz_id,
          companyName: application.companyName || application.company_name,
          jobTitle: application.jobTitle || application.job_title,
          jobUrl: application.jobUrl || application.job_url,
          capturedAt:
            application.proof_captured_at ||
            application.submitted_at ||
            new Date().toISOString(),
          status: currentStatus,
        }}
      />

      {/* Compact Job Header Card */}
      <div className="bg-white border-2 border-[#1A1A2E] rounded-xl px-4 py-3 md:px-5 md:py-3.5 mb-3 shadow-[3px_3px_0px_#1A1A2E]">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b-2 border-[#1A1A2E] pb-2.5 mb-2.5">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wider text-[#1A1A2E]">
                🏢 {application.companyName || application.company_name || 'Greenhouse Posting'}
              </span>
              <span className="text-[#1A1A2E] font-bold">•</span>
              <span className="text-[11px] font-mono font-bold text-[#1A1A2E] bg-[#FAF4EB] px-1.5 py-0.5 rounded border border-[#1A1A2E]">
                {application.applywizzId || application.applywizz_id}
              </span>
              <DifficultyBadge fieldsCount={fields.length} />
              <ApplicationStatusBadge
                status={badgeStatus}
                proofWebUrl={application.proof_web_url || application.proofWebUrl}
                proofEmailUrl={application.proof_email_url || application.proofEmailUrl}
                proofEmailJson={application.proof_email_json || application.proofEmailJson}
                emailProofStatus={application.email_proof_status || application.emailProofStatus}
                applicationId={appId}
                jobUrl={jobUrl}
                apiBaseUrl={apiBaseUrl}
                onStatusChange={onStatusChange}
              />
            </div>
            <h1 className="text-base md:text-lg font-bold text-[#1A1A2E] leading-tight truncate">
              {application.jobTitle || application.job_title || 'Application Form'}
            </h1>
            <a
              href={application.jobUrl || application.job_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                console.log(
                  `[Dashboard] Job link clicked: navigating to ${jobUrl}; submit handler not invoked`
                );
              }}
              className="text-[11px] md:text-xs text-[#2563EB] hover:underline font-mono truncate max-w-md block mt-0.5 font-medium"
            >
              {application.jobUrl || application.job_url}
            </a>
            {currentStatus === 'FAILED' &&
              (application.error_message || application.errorMessage) && (
                <p
                  className="mt-2 text-[11px] font-mono text-[#991B1B] bg-[#FEE2E2] border border-[#1A1A2E] rounded-lg px-2.5 py-1.5 max-w-2xl"
                  title="Failure reason from submission worker"
                >
                  {application.error_message || application.errorMessage}
                </p>
              )}
          </div>

          {/* Submission Action Controls */}
          <div className="shrink-0 flex flex-col items-end gap-1.5">
            <SubmissionControls
              applicationId={appId}
              jobUrl={jobUrl}
              status={currentStatus}
              unresolvedFieldsCount={unresCount}
              proofWebUrl={application.proof_web_url || application.proofWebUrl}
              proofEmailUrl={application.proof_email_url || application.proofEmailUrl}
              proofEmailJson={application.proof_email_json || application.proofEmailJson}
              emailProofStatus={application.email_proof_status || application.emailProofStatus}
              dryRunScreenshotUrl={
                application.dry_run_screenshot_url || application.dryRunScreenshotUrl
              }
              proofFailedUrl={
                application.proof_failed_url || application.proofFailedUrl
              }
              isSubmitting={isSubmitting}
              isDryRunning={isDryRunning}
              apiBaseUrl={apiBaseUrl}
              onTriggerDryRun={handleTriggerDryRun}
              onTriggerSubmit={handleTriggerSubmit}
              onStatusChange={onStatusChange}
              onViewProof={() => {
                const url = application.proof_web_url || application.proofWebUrl;
                if (url) {
                  setViewerImageUrl(url);
                  setViewerTitle('Live Application Confirmation Proof');
                  setViewerOpen(true);
                }
              }}
              onViewEmailProof={() => {
                const json = application.proof_email_json || application.proofEmailJson;
                if (json) {
                  setEmailProofOpen(true);
                }
              }}
              onViewDryRun={() => {
                const url =
                  application.dry_run_screenshot_url || application.dryRunScreenshotUrl;
                if (url) {
                  setViewerImageUrl(url);
                  setViewerTitle('Dry-Run Form Verification Screenshot');
                  setViewerOpen(true);
                }
              }}
              onViewFailureScreenshot={() => {
                const url = application.proof_failed_url || application.proofFailedUrl;
                if (url) {
                  setViewerImageUrl(url);
                  setViewerTitle('Failure Screenshot');
                  setViewerOpen(true);
                }
              }}
            />
          </div>
        </div>

        {/* Source Breakdown & Interactive Info Banner */}
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[#FAF4EB] border border-[#1A1A2E] rounded-lg px-3 py-1.5 text-xs text-[#1A1A2E]">
          <div className="flex items-center gap-1.5 font-medium text-[11px] md:text-xs">
            <span>✏️</span>
            <span>Operator Review — Click any field value to edit</span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {manualCount > 0 && (
              <span className="text-[11px] font-mono font-bold text-[#92400E] bg-[#FEF3C7] border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
                {manualCount} manual
              </span>
            )}
            <span className="text-[11px] font-mono font-bold text-[#065F46] bg-[#D1FAE5] border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
              {supabaseCount} supabase
            </span>
            <span className="text-[11px] font-mono font-bold text-[#5B21B6] bg-[#EDE9FE] border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
              {aiCount} ai
            </span>
            {unresCount > 0 && (
              <span className="text-[11px] font-mono font-bold text-white bg-[#EF4444] border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E] animate-pulse">
                {unresCount} unresolved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Form Fields Section (Card Carousel or Full List) */}
      <div className="space-y-4">
        {fields.length === 0 ? (
          <div className="bg-white border-2 border-[#1A1A2E] rounded-xl p-8 text-center text-[#64748B] shadow-[3px_3px_0px_#1A1A2E]">
            <p className="text-sm font-bold text-[#1A1A2E]">
              No interactive form fields extracted for this job posting.
            </p>
            {currentStatus === 'EXPIRED' && (
              <p className="text-xs text-[#EF4444] font-bold mt-1">
                This job posting appears to be closed or expired.
              </p>
            )}
          </div>
        ) : viewMode === 'carousel' ? (
          <div className="space-y-4">
            {/* Carousel Control & Filter Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-white border-2 border-[#1A1A2E] rounded-xl p-3 shadow-[2px_2px_0px_#1A1A2E]">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-[#1A1A2E]">
                  Field {boundedIndex + 1} of {displayFields.length}
                </span>
                <span className="text-xs font-mono font-bold text-[#065F46] bg-[#D1FAE5] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
                  {approvedFieldIds.size}/{displayFields.length} Approved
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFilterActionableOnly((prev) => !prev)}
                  className="text-xs font-bold text-[#1A1A2E] hover:text-[#2563EB] bg-[#FAF4EB] border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[1px_1px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
                >
                  {filterActionableOnly
                    ? `Showing Priority (${displayFields.length}) — Show All`
                    : `Showing All (${displayFields.length}) — Filter Priority`}
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className="text-xs font-bold text-[#1A1A2E] hover:text-[#2563EB] bg-[#FAF4EB] border border-[#1A1A2E] px-2.5 py-1 rounded shadow-[1px_1px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
                >
                  📋 Switch to Full List
                </button>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-[#E2E8F0] h-2 rounded-full overflow-hidden border border-[#1A1A2E]/20">
              <div
                className="bg-[#10B981] h-full transition-all duration-300"
                style={{
                  width: `${((boundedIndex + 1) / Math.max(1, displayFields.length)) * 100}%`,
                }}
              />
            </div>

            {/* Active Card in Carousel */}
            {currentField && (
              <div className="relative bg-[#FFFDF9] border-2 border-[#1A1A2E] rounded-xl p-5 shadow-[4px_4px_0px_#1A1A2E]">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-[#64748B]">
                      Question Card #{boundedIndex + 1}
                    </span>
                    {approvedFieldIds.has(currentField.fieldId) && (
                      <span className="text-[10px] font-mono font-bold text-[#065F46] bg-[#D1FAE5] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
                        ✅ Approved
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-[#64748B]">
                    Shortcut: <kbd className="bg-white px-1.5 py-0.5 rounded border border-gray-300 text-[10px] font-bold">Ctrl+Enter</kbd> to Approve & Next
                  </span>
                </div>

                <EditableFormField
                  field={currentField}
                  applicationId={appId}
                  jobUrl={jobUrl}
                  onFieldUpdate={(updated) => {
                    if (onFieldUpdate) onFieldUpdate(updated);
                  }}
                />

                {/* Card Action Buttons */}
                <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-[#1A1A2E]/15">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={boundedIndex === 0}
                      onClick={() => setCarouselIndex((i) => Math.max(0, i - 1))}
                      className="px-4 py-2 bg-white hover:bg-gray-50 text-[#1A1A2E] font-bold text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      ← Previous
                    </button>
                    <button
                      type="button"
                      disabled={boundedIndex >= displayFields.length - 1}
                      onClick={() => setCarouselIndex((i) => Math.min(displayFields.length - 1, i + 1))}
                      className="px-4 py-2 bg-white hover:bg-gray-50 text-[#1A1A2E] font-bold text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Skip →
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleApproveAll}
                      className="px-4 py-2 bg-[#FAF4EB] hover:bg-[#F3ECE1] text-[#1A1A2E] font-bold text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
                    >
                      Approve All
                    </button>
                    <button
                      type="button"
                      onClick={handleApproveAndNext}
                      className="px-5 py-2 bg-[#10B981] hover:bg-[#059669] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all flex items-center gap-2"
                    >
                      <span>Approve & Next →</span>
                      <span className="text-[10px] bg-white/20 px-1.5 py-0.5 rounded font-mono">Ctrl+↵</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Completion Banner */}
            {approvedFieldIds.size >= displayFields.length && (
              <div className="bg-[#D1FAE5] border-2 border-[#1A1A2E] rounded-xl p-4 shadow-[3px_3px_0px_#1A1A2E] flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-xl">🎉</span>
                  <div>
                    <p className="text-xs font-bold text-[#065F46]">
                      All {displayFields.length} review fields approved!
                    </p>
                    <p className="text-[11px] font-medium text-[#047857]">
                      Application verified and ready for live submission.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleTriggerSubmit}
                  disabled={submitFlowActive}
                  className="px-4 py-2 bg-[#10B981] hover:bg-[#059669] text-white font-black text-xs uppercase tracking-wider border-2 border-[#1A1A2E] rounded-xl shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {submitFlowActive ? 'Submitting...' : 'Approve & Submit Now →'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3.5">
            <div className="flex justify-between items-center bg-white border-2 border-[#1A1A2E] rounded-xl p-3 shadow-[2px_2px_0px_#1A1A2E]">
              <span className="text-xs font-mono font-bold text-[#1A1A2E]">
                Full Form View ({fields.length} fields)
              </span>
              <button
                type="button"
                onClick={() => setViewMode('carousel')}
                className="text-xs font-bold text-[#1A1A2E] hover:text-[#2563EB] bg-[#FAF4EB] border border-[#1A1A2E] px-3 py-1 rounded shadow-[1px_1px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
              >
                🎴 Switch to Card Carousel
              </button>
            </div>
            {fields.map((field: ResolvedField, index: number) => {
              return (
                <EditableFormField
                  key={`${field.fieldId}-${index}`}
                  field={field}
                  applicationId={appId}
                  jobUrl={jobUrl}
                  onFieldUpdate={onFieldUpdate}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default FormRenderer;
