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
    <aside className="w-80 flex-shrink-0 bg-[#1A1A2E] border-r border-[#131322] flex flex-col h-full overflow-hidden text-white">
      {/* Search Header */}
      <div className="p-4 border-b border-[#24243E] bg-[#1A1A2E] sticky top-0 z-10">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-[#94A3B8]">
            Candidates Directory
          </h2>
          <span className="text-xs font-mono bg-[#24243E] text-[#E2E8F0] px-2 py-0.5 rounded-full font-semibold">
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
            className="w-full bg-[#131324] border border-[#2E2E4A] rounded-lg px-3 py-2 text-xs text-white placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#F4D66B]/50 focus:border-[#F4D66B] transition-all"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-2 text-[#94A3B8] hover:text-white text-xs"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Candidate Card List */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#24243E]/60 p-2 space-y-1.5 custom-scrollbar">
        {isLoading ? (
          <div className="p-6 text-center text-xs text-[#94A3B8] animate-pulse">
            Loading candidate records...
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#94A3B8]">
            No candidates matching <span className="text-white">"{searchTerm}"</span>
          </div>
        ) : (
          filteredCandidates.map((c) => {
            const isSelected = c.applywizzId === selectedId;

            return (
              <button
                key={c.applywizzId}
                type="button"
                onClick={() => onSelectCandidate(c.applywizzId)}
                className={`w-full text-left p-3 rounded-xl transition-all duration-150 relative ${
                  isSelected
                    ? 'bg-[#2E2E54] border-2 border-[#F4D66B] shadow-lg shadow-black/20'
                    : 'bg-[#24243E]/50 border border-[#2F2F4E] hover:bg-[#2A2A48] hover:border-[#3D3D64]'
                }`}
              >
                {/* Candidate Name & ID */}
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-mono font-bold text-[#9AC89A] bg-[#1A1A2E] border border-[#355639] px-1.5 py-0.5 rounded">
                    {c.applywizzId}
                  </span>

                  {/* Status Indicator */}
                  {c.status === 'READY' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#9AC89A] bg-[#9AC89A]/20 px-2 py-0.5 rounded-full border border-[#9AC89A]/40">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#9AC89A] animate-pulse"></span>
                      Ready
                    </span>
                  )}
                  {c.status === 'PENDING' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#F4D66B] bg-[#F4D66B]/20 px-2 py-0.5 rounded-full border border-[#F4D66B]/40">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#F4D66B]"></span>
                      Pending
                    </span>
                  )}
                  {c.status === 'EXPIRED' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#94A3B8] bg-[#24243E] px-2 py-0.5 rounded-full border border-[#3D3D64]">
                      Expired
                    </span>
                  )}
                </div>

                {/* Candidate Full Name */}
                <div className="text-sm font-semibold text-white truncate mb-1">
                  {c.clientName}
                </div>

                {/* Meta details: Email & Job Pill */}
                <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                  <span className="truncate max-w-[140px] text-[#94A3B8] font-mono">
                    {c.email || c.location || 'Profile Synced'}
                  </span>

                  <span className="bg-[#131324] border border-[#2E2E4A] text-[#CBD5E1] px-2 py-0.5 rounded text-[10px] font-semibold font-mono">
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
