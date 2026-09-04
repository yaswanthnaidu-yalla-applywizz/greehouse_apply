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
      <div className="p-4 bg-slate-900/60 border-b border-slate-800 text-xs text-slate-500">
        No jobs assigned for this candidate.
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border-b border-slate-800 px-6 pt-3">
      {/* Queue Header & Counter */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Assigned Applications Queue
          </span>
          <span className="text-[11px] font-mono bg-blue-950/60 border border-blue-800/40 text-blue-400 px-2 py-0.5 rounded-full font-semibold">
            {candidate.jobs.length} Total
          </span>
        </div>

        {candidate.resumeUrl && (
          <a
            href={candidate.resumeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 bg-emerald-950/40 border border-emerald-800/50 hover:border-emerald-700 px-3 py-1 rounded-md transition-colors"
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
              className={`flex-shrink-0 text-left px-4 py-2.5 rounded-lg border transition-all duration-150 min-w-[220px] max-w-[280px] ${
                isSelected
                  ? 'bg-slate-800 border-blue-500 shadow-sm shadow-blue-950/30'
                  : 'bg-slate-950/60 border-slate-800 hover:bg-slate-800/50 hover:border-slate-700'
              }`}
            >
              {/* Company Name & Status Pill */}
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-slate-200 truncate">
                  {job.companyName || 'Company'}
                </span>

                {job.status === 'READY_FOR_REVIEW' && (
                  <span className="text-[10px] font-mono text-emerald-400 font-semibold">
                    🟢 Ready
                  </span>
                )}
                {job.status === 'EXPIRED' && (
                  <span className="text-[10px] font-mono text-rose-400 font-semibold">
                    🔴 Expired
                  </span>
                )}
                {job.status === 'PENDING' && (
                  <span className="text-[10px] font-mono text-amber-400 font-semibold">
                    🟡 Pending
                  </span>
                )}
              </div>

              {/* Job Title */}
              <div className="text-xs text-slate-300 truncate font-medium">
                {job.jobTitle || 'Job Application'}
              </div>

              {/* Question Count */}
              <div className="text-[10px] text-slate-500 mt-1 flex items-center justify-between">
                <span>{job.fieldsCount ? `${job.fieldsCount} Questions` : 'Scanned'}</span>
                <span className="font-mono text-slate-600">#{idx + 1}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
