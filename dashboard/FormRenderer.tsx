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

import React, { useState } from 'react';
import { EditableFormField } from './components/EditableFormField.js';
import { SourceBadge } from './components/SourceBadge.js';
import { ApplicationStatusBadge } from './components/ApplicationStatusBadge.js';
import { DifficultyBadge } from './components/DifficultyBadge.js';
import { SubmissionControls } from './components/SubmissionControls.js';
import { ProofViewer } from './components/ProofViewer.js';
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

  const fields: ResolvedField[] = application.resolvedFields || application.resolved_fields || [];
  const manualCount = fields.filter((f) => f.isEdited || f.source === 'manual').length;
  const supabaseCount = fields.filter((f) => f.source === 'supabase' && !f.isEdited).length;
  const aiCount = fields.filter((f) => f.source === 'ai' && !f.isEdited).length;
  const unresCount = fields.filter((f) => f.source === 'unresolved').length;

  const currentStatus: ApplicationStatus = application.status || 'READY_FOR_REVIEW';
  const appId = application.applywizzId || application.applywizz_id || application.id || 'app-default';
  const jobUrl = application.jobUrl || application.job_url || '';

  const resolveProofFromSubmitResponse = async (data: any) => {
    let proofWebUrl = data.proofWebUrl;
    let proofCapturedAt = data.proofCapturedAt;

    if (data.status === 'APPLIED' && !proofWebUrl) {
      try {
        const proofRes = await fetch(
          `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/proof`
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headless: false }),
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
    setIsSubmitting(true);
    if (onStatusChange) {
      onStatusChange('APPLYING');
    }
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/submit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headless: true }),
        }
      );
      const data = await res.json();
      const { proofWebUrl, proofCapturedAt } = await resolveProofFromSubmitResponse(data);

      if (data.status && onStatusChange) {
        onStatusChange(data.status, { ...data, proofWebUrl, proofCapturedAt });
      }
      if (proofWebUrl) {
        setViewerImageUrl(proofWebUrl);
        setViewerTitle('Live Application Confirmation Proof');
        setViewerOpen(true);
      }
    } catch (err: any) {
      console.error('Submission failed:', err);
      if (onStatusChange) {
        onStatusChange('FAILED', { error: err.message });
      }
      alert(`Submission error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-8 max-w-5xl mx-auto w-full custom-scrollbar">
      {/* Proof Viewer Modal */}
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

      {/* Job Header Card */}
      <div className="bg-white border-2 border-[#1A1A2E] rounded-xl p-6 mb-6 shadow-[4px_4px_0px_#1A1A2E]">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b-2 border-[#1A1A2E] pb-5 mb-5">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wider text-[#1A1A2E]">
                🏢 {application.companyName || application.company_name || 'Greenhouse Posting'}
              </span>
              <span className="text-[#1A1A2E] font-bold">•</span>
              <span className="text-xs font-mono font-bold text-[#1A1A2E] bg-[#FAF4EB] px-2 py-0.5 rounded border border-[#1A1A2E]">
                {application.applywizzId || application.applywizz_id}
              </span>
              <DifficultyBadge fieldsCount={fields.length} />
              <ApplicationStatusBadge
                status={currentStatus}
                applicationId={appId}
                apiBaseUrl={apiBaseUrl}
                onStatusChange={onStatusChange}
              />
            </div>
            <h1 className="text-xl font-bold text-[#1A1A2E]">
              {application.jobTitle || application.job_title || 'Application Form'}
            </h1>
            <a
              href={application.jobUrl || application.job_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#2563EB] hover:underline font-mono truncate max-w-lg mt-1 inline-block font-medium"
            >
              {application.jobUrl || application.job_url}
            </a>
          </div>

          {/* Submission Action Controls */}
          <div className="shrink-0 flex flex-col items-end gap-2">
            <SubmissionControls
              applicationId={appId}
              jobUrl={jobUrl}
              status={currentStatus}
              unresolvedFieldsCount={unresCount}
              proofWebUrl={application.proof_web_url || application.proofWebUrl}
              proofEmailUrl={application.proof_email_url || application.proofEmailUrl}
              dryRunScreenshotUrl={
                application.dry_run_screenshot_url || application.dryRunScreenshotUrl
              }
              isSubmitting={isSubmitting}
              isDryRunning={isDryRunning}
              apiBaseUrl={apiBaseUrl}
              onTriggerDryRun={handleTriggerDryRun}
              onTriggerSubmit={handleTriggerSubmit}
              onStatusChange={onStatusChange}
              onOtpVerified={({ proofWebUrl, proofCapturedAt }) => {
                if (proofWebUrl) {
                  setViewerImageUrl(proofWebUrl);
                  setViewerTitle('Live Application Confirmation Proof');
                  setViewerOpen(true);
                }
              }}
              onViewProof={() => {
                const url = application.proof_web_url || application.proofWebUrl;
                if (url) {
                  setViewerImageUrl(url);
                  setViewerTitle('Live Application Confirmation Proof');
                  setViewerOpen(true);
                }
              }}
              onViewEmailProof={() => {
                const url = application.proof_email_url || application.proofEmailUrl;
                if (url) {
                  setViewerImageUrl(url);
                  setViewerTitle('Zoho Confirmation Email Proof');
                  setViewerOpen(true);
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
            />
          </div>
        </div>

        {/* Source Breakdown & Interactive Info Banner */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-[#FAF4EB] border border-[#1A1A2E] rounded-lg px-4 py-2.5 text-xs text-[#1A1A2E]">
          <div className="flex items-center gap-2 font-medium">
            <span>✏️</span>
            <span>Operator Review — Click any field value below to edit answers inline</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {manualCount > 0 && (
              <span className="text-[11px] font-mono font-bold text-[#92400E] bg-[#FEF3C7] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
                {manualCount} manual
              </span>
            )}
            <span className="text-[11px] font-mono font-bold text-[#065F46] bg-[#D1FAE5] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
              {supabaseCount} supabase
            </span>
            <span className="text-[11px] font-mono font-bold text-[#5B21B6] bg-[#EDE9FE] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E]">
              {aiCount} ai
            </span>
            {unresCount > 0 && (
              <span className="text-[11px] font-mono font-bold text-white bg-[#EF4444] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E] animate-pulse">
                {unresCount} unresolved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Form Fields Section */}
      <div className="space-y-3.5">
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
        ) : (
          fields.map((field: ResolvedField, index: number) => {
            return (
              <EditableFormField
                key={`${field.fieldId}-${index}`}
                field={field}
                applicationId={appId}
                onFieldUpdate={onFieldUpdate}
              />
            );
          })
        )}
      </div>
    </div>
  );
};

export default FormRenderer;
