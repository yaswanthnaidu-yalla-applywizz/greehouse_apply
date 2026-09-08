/**
 * @fileoverview Right Pane Top: Horizontal Job Queue Navigation Tabs.
 *
 * Displays candidate-specific job assignments with company names, job titles,
 * and status indicators in a horizontal scrollable tab bar.
 *
 * References:
 * - 04-ui-ux.md (Section 2.3)
 */

import React from 'react';
import type { CandidateDetail } from './types.js';

/**
 * Props for JobQueueView component.
 */
export interface JobQueueViewProps {
  /** Candidate details with assigned job records */
  candidate: CandidateDetail;
  /** Currently selected job canonical or raw URL */
  selectedJobUrl: string | null;
  /** Callback fired when an operator selects a job tab */
  onSelectJob: (jobUrl: string) => void;
}

/**
 * Renders the candidate's assigned job tab bar.
 *
 * @param props - Component properties.
 * @returns React component.
 */
export const JobQueueView: React.FC<JobQueueViewProps> = ({
  candidate,
  selectedJobUrl,
  onSelectJob,
}) => {
  if (!candidate || !candidate.jobs || candidate.jobs.length === 0) {
    return (
      <div className="p-4 bg-[#FFF5EB] border-b border-[#E8DCCF] text-xs text-[#64748B]">
        No jobs assigned for this candidate.
      </div>
    );
  }

  return (
    <div className="bg-[#FFF5EB] border-b border-[#E8DCCF] px-6 pt-3">
      {/* Queue Header & Counter */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-[#1E293B]">
            Assigned Applications Queue
          </span>
          <span className="text-[11px] font-mono bg-[#B8D4E8] border border-[#A2C5DD] text-[#2D5C8C] px-2.5 py-0.5 rounded-full font-semibold">
            {candidate.jobs.length} Active
          </span>
          <span className="text-[11px] font-mono bg-[#9AC89A] border border-[#84B784] text-[#2D5C2D] px-2.5 py-0.5 rounded-full font-semibold">
            ⚡ &lt; 23 Qs
          </span>
        </div>

        {candidate.resumeUrl && (
          <a
            href={candidate.resumeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#059669] hover:text-[#047857] bg-[#FFFFFF] border border-[#84B784] hover:border-[#059669] px-3 py-1 rounded-lg shadow-sm transition-colors"
          >
            <span>📄</span>
            <span>Master Resume PDF</span>
          </a>
        )}
      </div>

      {/* Horizontal Scrollable Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-3 custom-scrollbar">
        {candidate.jobs.map((job, idx) => {
          const jobKey = job.canonicalUrl || job.rawUrl;
          const isSelected =
            selectedJobUrl === jobKey ||
            selectedJobUrl === job.rawUrl ||
            selectedJobUrl === job.canonicalUrl;

          return (
            <button
              key={`${jobKey}-${idx}`}
              type="button"
              onClick={() => onSelectJob(jobKey)}
              className={`flex-shrink-0 text-left px-4 py-2.5 rounded-xl border transition-all duration-150 min-w-[220px] max-w-[280px] ${
                isSelected
                  ? 'bg-[#FFFFFF] border-2 border-[#1A1A2E] shadow-md ring-2 ring-[#1A1A2E]/10'
                  : 'bg-[#FFFFFF] border-[#E8DCCF] hover:border-[#CDBDAE] shadow-sm'
              }`}
            >
              {/* Company Name & Status Pill */}
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-[#0F172A] truncate">
                  {job.companyName || 'Company'}
                </span>

                {job.status === 'READY_FOR_REVIEW' && (
                  <span className="text-[10px] font-mono text-[#059669] font-semibold">
                    🟢 Ready
                  </span>
                )}
                {job.status === 'EXPIRED' && (
                  <span className="text-[10px] font-mono text-[#E11D48] font-semibold">
                    🔴 Expired
                  </span>
                )}
                {job.status === 'PENDING' && (
                  <span className="text-[10px] font-mono text-[#D97706] font-semibold">
                    🟡 Pending
                  </span>
                )}
              </div>

              {/* Job Title */}
              <div className="text-xs text-[#334155] truncate font-medium">
                {job.jobTitle || 'Job Application'}
              </div>

              {/* Question Count */}
              <div className="text-[10px] text-[#64748B] mt-1 flex items-center justify-between">
                <span>{job.fieldsCount ? `${job.fieldsCount} Questions` : 'Scanned'}</span>
                <span className="font-mono text-[#94A3B8]">#{idx + 1}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
