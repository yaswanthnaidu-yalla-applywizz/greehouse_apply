/**
 * @fileoverview Left Sidebar: Candidate Directory and Filter View (Phase V2-UI).
 *
 * Renders candidate directory with neo-brutalist job board styling:
 * - Warm background (#FAF4EB / #FFF5EB) with crisp dark border (border-r-2 border-[#1A1A2E])
 * - Search input with dark border and coral active focus
 * - Card items with dark border, initials avatar, status pills, and hard shadow on active state
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-UI)
 */

import React, { useState, useMemo } from 'react';
import type { CandidateSummary } from './types.js';

export interface CandidateListProps {
  candidates: CandidateSummary[];
  selectedId: string | null;
  onSelectCandidate: (applywizzId: string) => void;
  isLoading?: boolean;
  emptyMessage?: string | null;
  selectedDate?: string | null;
}

export const CandidateList: React.FC<CandidateListProps> = ({
  candidates,
  selectedId,
  onSelectCandidate,
  isLoading = false,
  emptyMessage,
  selectedDate,
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
    <aside className="w-80 flex-shrink-0 bg-[#FAF4EB] border-r-2 border-[#1A1A2E] flex flex-col h-full overflow-hidden text-[#1A1A2E]">
      {/* Search Header */}
      <div className="p-4 border-b-2 border-[#1A1A2E] bg-[#FFF5EB] sticky top-0 z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">👥</span>
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#1A1A2E]">
              Candidates Directory
            </h2>
          </div>
          <span className="text-xs font-mono bg-white text-[#1A1A2E] border border-[#1A1A2E] px-2 py-0.5 rounded shadow-[1px_1px_0px_#1A1A2E] font-bold">
            {filteredCandidates.length} / {candidates.length}
          </span>
        </div>

        {selectedDate && (
          <div className="mb-2 px-2 py-0.5 bg-[#E2F0FB] border border-[#1A1A2E] rounded text-[10px] font-mono font-bold text-[#1E3A5F] flex items-center justify-between shadow-[1px_1px_0px_#1A1A2E]">
            <span>📅 Assigned: {selectedDate} (IST)</span>
          </div>
        )}

        {/* Real-time search filter input */}
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="🔍 Search name or AWL-ID..."
            className="w-full bg-white border-2 border-[#1A1A2E] rounded-md px-3 py-2 text-xs text-[#1A1A2E] placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#E88474] transition-all font-medium shadow-[1px_1px_0px_#1A1A2E]"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-2.5 text-[#64748B] hover:text-[#1A1A2E] text-xs font-bold"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Candidate Card List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
        {isLoading ? (
          <div className="p-6 text-center text-xs text-[#64748B] font-mono animate-pulse">
            Loading candidate records...
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#64748B]">
            {searchTerm ? (
              <>No candidates matching <span className="font-bold text-[#1A1A2E]">"{searchTerm}"</span></>
            ) : (
              emptyMessage || 'No candidates found.'
            )}
          </div>
        ) : (
          filteredCandidates.map((c) => {
            const isSelected = c.applywizzId === selectedId;
            const initials = c.clientName
              ? c.clientName
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .toUpperCase()
                  .slice(0, 2)
              : 'AW';

            return (
              <button
                key={c.applywizzId}
                type="button"
                onClick={() => onSelectCandidate(c.applywizzId)}
                className={`w-full text-left p-3 rounded-lg transition-all duration-150 relative ${
                  isSelected
                    ? 'bg-[#FFF5EB] border-2 border-[#1A1A2E] shadow-[3px_3px_0px_#1A1A2E] ring-1 ring-[#1A1A2E]'
                    : 'bg-white border border-[#1A1A2E] hover:bg-[#FFFDF9] shadow-[2px_2px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px]'
                }`}
              >
                {/* Top Row: Initials Avatar + ID + Status */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-[#B8D4E8] text-[#1E3A5F] border border-[#1A1A2E] flex items-center justify-center text-[10px] font-bold">
                      {initials}
                    </span>
                    <span className="text-[11px] font-mono font-bold text-[#1A1A2E] bg-[#FAF4EB] border border-[#1A1A2E] px-1.5 py-0.5 rounded">
                      {c.applywizzId}
                    </span>
                  </div>

                  {/* Status Indicator Pill */}
                  {c.status === 'READY' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#1E4620] bg-[#9AC89A] px-2 py-0.5 rounded border border-[#1A1A2E]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#1E4620] animate-pulse"></span>
                      Ready
                    </span>
                  )}
                  {c.status === 'PENDING' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#5C4A0A] bg-[#F4D66B] px-2 py-0.5 rounded border border-[#1A1A2E]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#5C4A0A]"></span>
                      Pending
                    </span>
                  )}
                  {c.status === 'EXPIRED' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#475569] bg-[#E2E8F0] px-2 py-0.5 rounded border border-[#1A1A2E]">
                      Expired
                    </span>
                  )}
                </div>

                {/* Candidate Full Name */}
                <div className="text-xs font-bold text-[#1A1A2E] truncate mb-1">
                  {c.clientName}
                </div>

                {/* Bottom Row: Location/Email & Job Count Pill */}
                <div className="flex items-center justify-between text-[11px] text-[#64748B]">
                  <span className="truncate max-w-[130px] font-medium text-[#64748B]">
                    {c.email || c.location || 'Profile Synced'}
                  </span>

                  <span className="bg-[#FAF4EB] border border-[#1A1A2E] text-[#1A1A2E] px-2 py-0.5 rounded text-[10px] font-bold font-mono">
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

export default CandidateList;
