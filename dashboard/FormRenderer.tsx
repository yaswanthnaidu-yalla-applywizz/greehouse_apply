/**
 * @fileoverview Right Pane Main: Dynamic Form Renderer with Submission Controls & Proof Viewer (Phase V2-5).
 *
 * References:
 * - 04-ui-ux.md
 * - V2-implementation.md (Phase V2-5)
 */

import React, { useState } from 'react';
import { EditableFormField } from './components/EditableFormField.js';
import { SourceBadge } from './components/SourceBadge.js';
import { ApplicationStatusBadge } from './components/ApplicationStatusBadge.js';
import { SubmissionControls } from './components/SubmissionControls.js';
import { ProofViewer } from './components/ProofViewer.js';
import type { ResolvedField, ApplicationStatus } from './types.js';

export { SourceBadge, ApplicationStatusBadge, SubmissionControls, ProofViewer };

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
        <div className="w-8 h-8 border-2 border-[#059669] border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-xs font-mono">Loading application form...</p>
      </div>
    );
  }

  if (!application) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-[#64748B]">
        <div className="text-3xl mb-2">📋</div>
        <p className="text-sm font-semibold text-[#1E293B]">No Job Selected</p>
        <p className="text-xs text-[#64748B] mt-1">
          Select a candidate and job tab to inspect and edit pre-populated form questions.
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
  const appId = application.id || application.applywizzId || 'app-default';

  const handleTriggerDryRun = async () => {
    setIsDryRunning(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/dry-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headless: false }),
      });
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
      const res = await fetch(`${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headless: true }),
      });
      const data = await res.json();
      if (data.status && onStatusChange) {
        onStatusChange(data.status, data);
      }
      if (data.proofWebUrl) {
        setViewerImageUrl(data.proofWebUrl);
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

  const handleResumeCaptcha = async () => {
    setIsSubmitting(true);
    if (onStatusChange) {
      onStatusChange('APPLYING');
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/resume-submission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.status && onStatusChange) {
        onStatusChange(data.status, data);
      }
      if (data.proofWebUrl) {
        setViewerImageUrl(data.proofWebUrl);
        setViewerTitle('Live Application Confirmation Proof');
        setViewerOpen(true);
      }
    } catch (err: any) {
      console.error('Resume submission error:', err);
      alert(`Resume submission error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full custom-scrollbar">
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
          capturedAt: application.proof_captured_at || application.submitted_at || new Date().toISOString(),
          status: currentStatus,
        }}
      />

      {/* Job Header Card */}
      <div className="bg-[#FFFFFF] border border-[#E8DCCF] rounded-xl p-6 mb-8 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 border-b border-[#E8DCCF] pb-5 mb-5">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-wider text-[#64748B]">
                {application.companyName || application.company_name || 'Greenhouse Posting'}
              </span>
              <span className="text-[#CBD5E1]">•</span>
              <span className="text-xs font-mono text-[#059669] bg-[#FAF6F0] px-2 py-0.5 rounded border border-[#9AC89A]">
                {application.applywizzId || application.applywizz_id}
              </span>
              <ApplicationStatusBadge
                status={currentStatus}
                applicationId={appId}
                apiBaseUrl={apiBaseUrl}
                onStatusChange={onStatusChange}
              />
            </div>
            <h1 className="text-xl font-bold text-[#0F172A]">
              {application.jobTitle || application.job_title || 'Application Form'}
            </h1>
            <a
              href={application.jobUrl || application.job_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#0284C7] hover:text-[#0369A1] font-mono underline break-all mt-1 inline-block"
            >
              {application.jobUrl || application.job_url}
            </a>
          </div>

          {/* Submission Action Controls */}
          <div className="shrink-0 flex flex-col items-end gap-2">
            <SubmissionControls
              applicationId={appId}
              status={currentStatus}
              unresolvedFieldsCount={unresCount}
              proofWebUrl={application.proof_web_url || application.proofWebUrl}
              dryRunScreenshotUrl={application.dry_run_screenshot_url || application.dryRunScreenshotUrl}
              isSubmitting={isSubmitting}
              isDryRunning={isDryRunning}
              onTriggerDryRun={handleTriggerDryRun}
              onTriggerSubmit={handleTriggerSubmit}
              onResumeCaptcha={handleResumeCaptcha}
              onViewProof={() => {
                const url = application.proof_web_url || application.proofWebUrl;
                if (url) {
                  setViewerImageUrl(url);
                  setViewerTitle('Live Application Confirmation Proof');
                  setViewerOpen(true);
                }
              }}
              onViewDryRun={() => {
                const url = application.dry_run_screenshot_url || application.dryRunScreenshotUrl;
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
        <div className="flex flex-wrap items-center justify-between gap-3 bg-[#FAF6F0] border border-[#E8DCCF] rounded-lg px-4 py-2.5 text-xs text-[#64748B]">
          <div className="flex items-center gap-2">
            <span className="text-amber-600">✏️</span>
            <span>Interactive Operator Review (V2) — Click any field to edit answers inline</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {manualCount > 0 && (
              <span className="text-[11px] font-mono font-bold text-amber-800 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded">
                {manualCount} manual
              </span>
            )}
            <span className="text-[11px] font-mono font-bold text-[#2D5C2D] bg-[#9AC89A]/30 border border-[#9AC89A] px-2 py-0.5 rounded">
              {supabaseCount} supabase
            </span>
            <span className="text-[11px] font-mono font-bold text-[#6D28D9] bg-[#8B5CF6]/15 border border-[#8B5CF6]/40 px-2 py-0.5 rounded">
              {aiCount} ai
            </span>
            {unresCount > 0 && (
              <span className="text-[11px] font-mono font-bold text-rose-800 bg-rose-50 border border-rose-300 px-2 py-0.5 rounded animate-pulse">
                {unresCount} unresolved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Form Fields Section */}
      <div className="space-y-4">
        {fields.length === 0 ? (
          <div className="bg-[#FFFFFF] border border-[#E8DCCF] rounded-xl p-8 text-center text-[#64748B] shadow-sm">
            <p className="text-sm">No interactive form fields extracted for this job posting.</p>
            {currentStatus === 'EXPIRED' && (
              <p className="text-xs text-[#E11D48] mt-1">This job posting appears to be closed or expired.</p>
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
