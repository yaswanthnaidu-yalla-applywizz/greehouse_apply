/**
 * @fileoverview Left Sidebar: Candidate Directory and Filter View.
 *
 * Provides real-time search filtering, candidate status badges, job count indicators,
 * and active selection highlights for the split-screen operator interface.
 *
 * References:
 * - 04-ui-ux.md (Section 2.2)
 */

import React, { useState, useMemo } from 'react';
import type { CandidateSummary } from './types.js';

/**
 * Props for CandidateList component.
 */
export interface CandidateListProps {
  /** Array of candidate summary records */
  candidates: CandidateSummary[];
  /** Currently active candidate ID */
  selectedId: string | null;
  /** Callback fired when an operator selects a candidate card */
  onSelectCandidate: (applywizzId: string) => void;
  /** Whether candidate list is loading */
  isLoading?: boolean;
}

/**
 * Renders the left-hand sidebar candidate directory.
 *
 * @param props - Component properties.
 * @returns React component.
 */
export const CandidateList: React.FC<CandidateListProps> = ({
  candidates,
  selectedId,
  onSelectCandidate,
  isLoading = false,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  // Filter candidates in real-time by Name or Applywizz ID
  const filteredCandidates = useMemo(() => {
    const query = searchTerm.toLowerCase().trim();
    if (!query) return candidates;

    return candidates.filter(
      (c) =>
        c.clientName.toLowerCase().includes(query) ||
        c.applywizzId.toLowerCase().includes(query) ||
        c.email.toLowerCase().includes(query)
    );
  }, [candidates, searchTerm]);

  return (
    <aside className="w-80 flex-shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col h-full overflow-hidden">
      {/* Search Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Candidates Directory
          </h2>
          <span className="text-xs font-mono bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full">
            {filteredCandidates.length} of {candidates.length}
          </span>
        </div>

        {/* Real-time search filter input */}
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search name or AWL-ID..."
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-all"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-2 text-slate-500 hover:text-slate-300 text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Candidate Card List */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 p-2 space-y-1.5 custom-scrollbar">
        {isLoading ? (
          <div className="p-6 text-center text-xs text-slate-500 animate-pulse">
            Loading candidate records...
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            No candidates matching <span className="text-slate-300">"{searchTerm}"</span>
          </div>
        ) : (
          filteredCandidates.map((c) => {
            const isSelected = c.applywizzId === selectedId;

            return (
              <button
                key={c.applywizzId}
                type="button"
                onClick={() => onSelectCandidate(c.applywizzId)}
                className={`w-full text-left p-3 rounded-lg transition-all duration-150 relative ${
                  isSelected
                    ? 'bg-slate-800 border-2 border-emerald-500 shadow-md shadow-emerald-950/20'
                    : 'bg-slate-800/40 border border-slate-800/80 hover:bg-slate-800/80 hover:border-slate-700'
                }`}
              >
                {/* Candidate Name & ID */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-1.5 py-0.5 rounded">
                    {c.applywizzId}
                  </span>

                  {/* Status Indicator */}
                  {c.status === 'READY' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-800/40">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                      Ready
                    </span>
                  )}
                  {c.status === 'PENDING' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-950/40 px-2 py-0.5 rounded-full border border-amber-800/40">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                      Pending
                    </span>
                  )}
                  {c.status === 'EXPIRED' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-400 bg-slate-800/60 px-2 py-0.5 rounded-full">
                      Expired
                    </span>
                  )}
                </div>

                {/* Candidate Full Name */}
                <div className="text-sm font-semibold text-slate-100 truncate mb-1">
                  {c.clientName}
                </div>

                {/* Meta details: Email & Job Pill */}
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="truncate max-w-[140px] text-slate-400 font-mono">
                    {c.email || c.location || 'Profile Synced'}
                  </span>

                  <span className="bg-slate-900 border border-slate-700/80 text-slate-300 px-2 py-0.5 rounded text-[10px] font-semibold">
                    {c.totalJobs} {c.totalJobs === 1 ? 'Job' : 'Jobs'}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
