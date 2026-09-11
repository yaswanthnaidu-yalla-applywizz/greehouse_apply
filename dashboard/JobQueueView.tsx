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

import React from 'react';
import { DifficultyBadge } from './components/DifficultyBadge.js';
import type { CandidateDetail } from './types.js';

export interface JobQueueViewProps {
  /** Candidate details with assigned job records */
  candidate: CandidateDetail;
  /** Currently selected job canonical or raw URL */
  selectedJobUrl: string | null;
  /** Callback fired when an operator selects a job tab */
  onSelectJob: (jobUrl: string) => void;
}

export const JobQueueView: React.FC<JobQueueViewProps> = ({
  candidate,
  selectedJobUrl,
  onSelectJob,
}) => {
  const handleJobSelect = (job: CandidateJob) => {
    const jobKey = job.canonicalUrl || job.rawUrl;
    const currentStatus = job.status || 'READY_FOR_REVIEW';
    console.log(
      `[Dashboard] Card clicked: ${job.jobTitle || jobKey} status=${currentStatus} → action taken: navigate`
    );
    onSelectJob(jobKey);
  };

  if (!candidate || !candidate.jobs || candidate.jobs.length === 0) {
    return (
      <div className="p-4 bg-[#FFF5EB] border-b-2 border-[#1A1A2E] text-xs font-mono text-[#64748B]">
        No jobs assigned for this candidate.
      </div>
    );
  }

  return (
    <div className="bg-[#FFF5EB] border-b-2 border-[#1A1A2E] px-6 pt-3">
      {/* Queue Header & Counter */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-[#1A1A2E]">
            Assigned Applications Queue
          </span>
          <span className="text-[11px] font-mono bg-[#B8D4E8] border border-[#1A1A2E] text-[#1E3A5F] px-2 py-0.5 rounded font-bold shadow-[1px_1px_0px_#1A1A2E]">
            {candidate.jobs.length} Active
          </span>
          <span className="text-[11px] font-mono bg-[#9AC89A] border border-[#1A1A2E] text-[#1E4620] px-2 py-0.5 rounded font-bold shadow-[1px_1px_0px_#1A1A2E]">
            ⚡ &lt; 23 Qs
          </span>
        </div>

        {candidate.resumeUrl && (
          <a
            href={candidate.resumeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-[#1E4620] hover:text-[#143015] bg-[#9AC89A] border border-[#1A1A2E] px-3 py-1 rounded shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
          >
            <span>📄</span>
            <span>Master Resume PDF</span>
          </a>
        )}
      </div>

      {/* Horizontal Scrollable Tabs */}
      <div className="flex gap-2.5 overflow-x-auto pb-3 custom-scrollbar">
        {[...candidate.jobs]
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

          const initial = job.companyName ? job.companyName[0].toUpperCase() : 'G';

          return (
            <button
              key={`${jobKey}-${idx}`}
              type="button"
              onClick={() => handleJobSelect(job)}
              className={`flex-shrink-0 text-left px-3.5 py-2.5 rounded-lg transition-all duration-150 min-w-[230px] max-w-[280px] ${
                isSelected
                  ? 'bg-[#FFF5EB] border-2 border-[#1A1A2E] shadow-[3px_3px_0px_#1A1A2E] ring-1 ring-[#1A1A2E]'
                  : 'bg-white border border-[#1A1A2E] hover:bg-[#FFFDF9] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px]'
              }`}
            >
              {/* Top Row: Company Initial Badge + Company Name + Difficulty */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 truncate max-w-[150px]">
                  <span className="w-5 h-5 rounded bg-[#FAF4EB] border border-[#1A1A2E] text-[10px] font-bold text-[#1A1A2E] flex items-center justify-center shrink-0">
                    {initial}
                  </span>
                  <span className="text-xs font-bold text-[#1A1A2E] truncate">
                    {job.companyName || 'Company'}
                  </span>
                </div>

                <DifficultyBadge fieldsCount={job.fieldsCount} />
              </div>

              {/* Job Title & Queue Priority Badge */}
              <div className="flex items-center justify-between gap-1.5 mb-1">
                <div className="text-xs text-[#1A1A2E] font-medium truncate">
                  {job.jobTitle || 'Job Application'}
                </div>
                {Boolean((job as any).has_manual_edits || job.hasManualEdits) && (
                  <span
                    className="text-[9px] font-mono font-bold text-[#92400E] bg-[#FEF3C7] border border-[#1A1A2E] px-1.5 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E] shrink-0"
                    title="Application has manual operator edits and is queued last"
                  >
                    ⚠️ Edited (Queued Last)
                  </span>
                )}
              </div>

              {/* Bottom Row: Status Pill & Question Count */}
              <div className="flex items-center justify-between text-[10px] mt-1 pt-1 border-t border-[#1A1A2E]/20">
                <span className="font-mono text-[#64748B]">
                  {job.fieldsCount ? `${job.fieldsCount} Qs` : 'Scanned'}
                </span>

                {job.status === 'APPLIED' && (
                  <span className="text-[10px] font-mono text-[#1E4620] font-bold bg-[#9AC89A] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    ✅ Applied
                  </span>
                )}
                {job.status === 'APPLYING' && (
                  <span className="text-[10px] font-mono text-white font-bold bg-[#E88474] border border-[#1A1A2E] px-1.5 py-0.2 rounded animate-pulse">
                    ⏳ Submitting
                  </span>
                )}
                {job.status === 'DRY_RUN_COMPLETE' && (
                  <span className="text-[10px] font-mono text-[#1E3A5F] font-bold bg-[#B8D4E8] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    🚀 Dry-Run
                  </span>
                )}
                {job.status === 'OTP_REQUIRED' && (
                  <span className="text-[10px] font-mono text-white font-bold bg-[#F59E0B] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    🔒 OTP
                  </span>
                )}
                {job.status === 'FAILED' && (
                  <span className="text-[10px] font-mono text-white font-bold bg-[#EF4444] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    ❌ Failed
                  </span>
                )}
                {job.status === 'READY_FOR_REVIEW' && (
                  <span className="text-[10px] font-mono text-[#5C4A0A] font-bold bg-[#F4D66B] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    🟡 Ready
                  </span>
                )}
                {job.status === 'EXPIRED' && (
                  <span className="text-[10px] font-mono text-[#475569] font-bold bg-[#E2E8F0] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    Closed
                  </span>
                )}
                {job.status === 'PENDING' && (
                  <span className="text-[10px] font-mono text-[#5C4A0A] font-bold bg-[#F4D66B] border border-[#1A1A2E] px-1.5 py-0.2 rounded">
                    Pending
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default JobQueueView;
