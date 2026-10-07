/**
 * @fileoverview Right Pane Top: Horizontal Job Queue Navigation Tabs (Phase V2-UI).
 *
 * Displays candidate-specific job assignments with company names, job titles,
 * difficulty badges (Easy, Medium, Hard), and status indicators matching the reference aesthetic.
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-UI)
 */

import React, { useState, useMemo } from 'react';
import { DifficultyBadge } from './components/DifficultyBadge.js';
import { ProofViewer } from './components/ProofViewer.js';
import type { CandidateDetail } from './types.js';
import {
  candidateDetailMatchesSelection,
  filterOperatorApplicationJobs,
  filterJobsForCandidate,
  isSkippedApplicationJob,
  isUnresolvedApplicationJob,
  jobCardCompanyLabel,
  jobCardTitleLabel,
} from '../src/dashboard/candidateQueueFilter.js';

export interface JobQueueViewProps {
  /** Candidate details with assigned job records */
  candidate: CandidateDetail;
  /** Selected directory applywizz_id — queue must match this exactly */
  selectedApplywizzId: string | null;
  /** Currently selected job canonical or raw URL */
  selectedJobUrl: string | null;
  /** Return to the mobile candidate list */
  onBack: () => void;
  /** Expand/collapse job for review only — never starts submit/dry-run */
  onSelectJob: (jobUrl: string | null) => void;
}

type CandidateJob = CandidateDetail['jobs'][number];

export const JobQueueView: React.FC<JobQueueViewProps> = ({
  candidate,
  selectedApplywizzId,
  selectedJobUrl,
  onBack,
  onSelectJob,
}) => {
  const [proofViewerState, setProofViewerState] = useState<{
    isOpen: boolean;
    applicationId: string | null;
    kind: 'web' | 'failed' | 'email';
    metadata: {
      candidateName?: string;
      applywizzId?: string;
      companyName?: string;
      jobTitle?: string;
      jobUrl?: string;
      status?: string;
    };
  }>({
    isOpen: false,
    applicationId: null,
    kind: 'web',
    metadata: {},
  });

  const handleProofBadgeClick = (job: CandidateJob, kind: 'web' | 'failed') => {
    const appId =
      (job as any).id ||
      (job as any).applicationId ||
      (job as any).application_id ||
      job.applywizzId ||
      job.applywizz_id ||
      selectedApplywizzId ||
      candidate.applywizzId;

    const jobUrl = job.canonicalUrl || job.rawUrl;

    setProofViewerState({
      isOpen: true,
      applicationId: appId,
      kind,
      metadata: {
        candidateName: candidate.clientName,
        applywizzId: job.applywizzId || job.applywizz_id || selectedApplywizzId || candidate.applywizzId,
        companyName: jobCardCompanyLabel(job),
        jobTitle: jobCardTitleLabel(job),
        jobUrl,
        status: job.status,
      },
    });
  };

  const queueJobs = useMemo(() => {
    if (!selectedApplywizzId || !candidateDetailMatchesSelection(candidate, selectedApplywizzId)) {
      return [];
    }
    const owned = filterJobsForCandidate(candidate.jobs || [], selectedApplywizzId);
    return filterOperatorApplicationJobs(owned);
  }, [candidate, selectedApplywizzId]);
  const backButton = (
    <button type="button" onClick={onBack} className="mobile-screen-back">
      <span aria-hidden="true">←</span> Candidates
    </button>
  );
  const handleJobCardClick = (job: CandidateJob) => {
    const jobKey = job.canonicalUrl || job.rawUrl;
    const currentStatus = job.status || 'READY_FOR_REVIEW';
    const alreadyExpanded =
      selectedJobUrl === jobKey ||
      selectedJobUrl === job.rawUrl ||
      selectedJobUrl === job.canonicalUrl;

    const isMobile =
      typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
    if (alreadyExpanded && !isMobile) {
      console.log(
        `[Dashboard] Card clicked: ${job.jobTitle || jobKey} status=${currentStatus} → collapse (no submit)`
      );
      onSelectJob(null);
      return;
    }

    console.log(
      `[Dashboard] Card clicked: ${job.jobTitle || jobKey} status=${currentStatus} → expand for review (no submit)`
    );
    onSelectJob(jobKey);
  };

  if (!candidate || !selectedApplywizzId || !candidateDetailMatchesSelection(candidate, selectedApplywizzId)) {
    return (
      <div className="mobile-job-queue mobile-job-queue-message p-4 bg-[#FFF5EB] border-b-2 border-[#1A1A2E] text-xs font-mono text-[#64748B]">
        {backButton}
        <div>Loading applications for {selectedApplywizzId || 'candidate'}…</div>
      </div>
    );
  }

  if (queueJobs.length === 0) {
    return (
      <div className="mobile-job-queue mobile-job-queue-message p-4 bg-[#FFF5EB] border-b-2 border-[#1A1A2E] text-xs font-mono text-[#64748B]">
        {backButton}
        <div>No jobs assigned for this candidate.</div>
      </div>
    );
  }

  return (
    <div className="mobile-job-queue bg-[#FFF5EB] border-b-2 border-[#1A1A2E] px-6 pt-3">
      {backButton}
      {/* Queue Header & Counter */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">
            Assigned Applications Queue
          </span>
          <span className="text-[11px] font-mono bg-[#2c2c2e] border border-[#3a3a3c] text-[#0a84ff] px-2 py-0.5 rounded-md font-medium">
            {queueJobs.length} Active
          </span>
          <span className="text-[11px] font-mono bg-[#30d158]/15 border border-[#30d158]/30 text-[#30d158] px-2 py-0.5 rounded-md font-medium">
            ⚡ &lt; 35 Qs
          </span>
        </div>

        {candidate.resumeUrl && (
          <a
            href={candidate.resumeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#30d158] hover:text-[#ffffff] bg-[#30d158]/15 hover:bg-[#30d158]/25 border border-[#30d158]/30 px-3 py-1 rounded-md transition-all"
          >
            <span>📄</span>
            <span>Master Resume PDF</span>
          </a>
        )}
      </div>

      {/* Horizontal Scrollable Tabs */}
      <div className="mobile-job-list flex gap-2.5 overflow-x-auto pb-3 custom-scrollbar">
        {[...queueJobs]
          .sort((a, b) => {
            const aEdited = a.hasManualEdits ? 1 : 0;
            const bEdited = b.hasManualEdits ? 1 : 0;
            return aEdited - bEdited;
          })
          .map((job, idx) => {
          const jobKey = job.canonicalUrl || job.rawUrl;
          const isSelected =
            selectedJobUrl === jobKey ||
            selectedJobUrl === job.rawUrl ||
            selectedJobUrl === job.canonicalUrl;

          const cardCompany = jobCardCompanyLabel(job);
          const cardTitle = jobCardTitleLabel(job);
          const initial = cardCompany ? cardCompany[0].toUpperCase() : 'G';

          return (
            <button
              key={`${jobKey}-${idx}`}
              type="button"
              onClick={() => handleJobCardClick(job)}
              className={`mobile-job-card flex-shrink-0 text-left px-3.5 py-2.5 rounded-xl transition-all duration-150 min-w-[230px] max-w-[280px] ${
                isSelected
                  ? 'bg-[#2c2c2e] border border-[#3a3a3c]'
                  : 'bg-[#1c1c1e] border border-[#2c2c2e] hover:bg-[#2c2c2e]/60'
              }`}
            >
              {/* Top Row: Company Initial Badge + Company Name + Difficulty */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 truncate max-w-[150px]">
                  <span className="w-5 h-5 rounded bg-[#2c2c2e] border border-[#3a3a3c] text-[10px] font-bold text-[#ffffff] flex items-center justify-center shrink-0">
                    {initial}
                  </span>
                  <span className="text-xs font-semibold text-[#ffffff] truncate">
                    {cardCompany}
                  </span>
                </div>

                <DifficultyBadge fieldsCount={job.fieldsCount} />
              </div>

              {/* Job Title & Queue Priority Badge */}
              <div className="flex items-center justify-between gap-1.5 mb-1">
                <div className="text-xs text-[#8e8e93] font-medium truncate">
                  {cardTitle}
                </div>
                {Boolean((job as any).has_manual_edits || job.hasManualEdits) && (
                  <span
                    className="text-[9px] font-mono font-bold text-[#ff9f0a] bg-[#ff9f0a]/15 border border-[#ff9f0a]/30 px-1.5 py-0.5 rounded-md shrink-0"
                    title="Application has manual operator edits and is queued last"
                  >
                    ⚠️ Edited (Queued Last)
                  </span>
                )}
              </div>

              {/* Bottom Row: Status Pill & Question Count */}
              <div className="flex items-center justify-between text-[10px] mt-1 pt-1 border-t border-[#2c2c2e] gap-1">
                <span className="font-mono text-[#8e8e93] shrink-0">
                  {job.fieldsCount ? `${job.fieldsCount} Qs` : 'Scanned'}
                </span>

                <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                  {isSkippedApplicationJob(job) && (
                    <span
                      className="text-[10px] font-mono text-[#ff9f0a] font-semibold bg-[#ff9f0a]/15 border border-[#ff9f0a]/30 px-1.5 py-0.5 rounded-full"
                      title="This job was intentionally skipped — open the card for the reason"
                    >
                      ⏭ Skipped
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && isUnresolvedApplicationJob(job) && (
                    <span
                      className="text-[10px] font-mono text-[#ff453a] font-semibold bg-[#ff453a]/15 border border-[#ff453a]/30 px-1.5 py-0.5 rounded-full"
                      title="Resolver has not finished or required fields are still unresolved"
                    >
                      ⚠️ Unresolved
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'APPLIED' && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleProofBadgeClick(job, 'web');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          handleProofBadgeClick(job, 'web');
                        }
                      }}
                      title="Click to view confirmation proof directly"
                      className="text-[10px] font-mono text-[#30d158] font-semibold bg-[#30d158]/15 hover:bg-[#30d158]/25 border border-[#30d158]/30 px-1.5 py-0.5 rounded-full cursor-pointer transition-all"
                    >
                      ✅ Applied
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'APPLYING' && (
                    <span className="text-[10px] font-mono text-[#ff9f0a] font-semibold bg-[#ff9f0a]/15 border border-[#ff9f0a]/30 px-1.5 py-0.5 rounded-full animate-pulse">
                      ⏳ Submitting
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'DRY_RUN_COMPLETE' && (
                    <span className="text-[10px] font-mono text-[#ffffff] font-semibold bg-[#3a3a3c] border border-[#48484a] px-1.5 py-0.5 rounded-full">
                      🚀 Dry-Run
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'OTP_REQUIRED' && (
                    <span className="text-[10px] font-mono text-[#ff9f0a] font-semibold bg-[#ff9f0a]/15 border border-[#ff9f0a]/30 px-1.5 py-0.5 rounded-full">
                      🔒 OTP
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'FAILED' && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleProofBadgeClick(job, 'failed');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          handleProofBadgeClick(job, 'failed');
                        }
                      }}
                      title="Click to view failure screenshot proof directly"
                      className="text-[10px] font-mono text-[#ff453a] font-semibold bg-[#ff453a]/15 hover:bg-[#ff453a]/25 border border-[#ff453a]/30 px-1.5 py-0.5 rounded-full cursor-pointer transition-all"
                    >
                      ❌ Failed
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'READY_FOR_REVIEW' && (
                    <span className="text-[10px] font-mono text-[#ffffff] font-semibold bg-[#3a3a3c] border border-[#48484a] px-1.5 py-0.5 rounded-full">
                      Ready
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'EXPIRED' && (
                    <span className="text-[10px] font-mono text-[#8e8e93] font-semibold bg-[#2c2c2e] border border-[#3a3a3c] px-1.5 py-0.5 rounded-full">
                      Closed
                    </span>
                  )}
                  {!isSkippedApplicationJob(job) && job.status === 'PENDING' && (
                    <span className="text-[10px] font-mono text-[#ff9f0a] font-semibold bg-[#ff9f0a]/15 border border-[#ff9f0a]/30 px-1.5 py-0.5 rounded-full">
                      Pending
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <ProofViewer
        isOpen={proofViewerState.isOpen}
        onClose={() => setProofViewerState((prev) => ({ ...prev, isOpen: false }))}
        applicationId={proofViewerState.applicationId}
        kind={proofViewerState.kind}
        title={proofViewerState.kind === 'failed' ? 'Failure Screenshot' : 'Application Verification Proof'}
        metadata={proofViewerState.metadata}
      />
    </div>
  );
};

export default JobQueueView;
