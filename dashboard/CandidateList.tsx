/**
 * @fileoverview Left Sidebar: Candidate Directory and Filter View (Phase V2-UI).
 *
 * Renders candidate directory with neo-brutalist job board styling:
 * - Warm background (#FAF4EB / #FFF5EB) with crisp dark border (border-r-2 border-[#1A1A2E])
 * - Search input with dark border and coral active focus
 * - Card items with dark border, initials avatar, status pills
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
    <aside className="w-80 flex-shrink-0 bg-[#1c1c1e] border-r border-[#2c2c2e] flex flex-col h-full overflow-hidden text-[#ffffff]">
      {/* Search Header */}
      <div className="p-4 border-b border-[#2c2c2e] bg-[#1c1c1e] sticky top-0 z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">👥</span>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8e8e93]">
              Candidates Directory
            </h2>
          </div>
          <span className="text-xs font-mono bg-[#2c2c2e] text-[#8e8e93] border border-[#3a3a3c] px-2 py-0.5 rounded-md font-medium">
            {filteredCandidates.length} / {candidates.length}
          </span>
        </div>

        {selectedDate && (
          <div className="mb-2 px-2 py-1 bg-[#2c2c2e] border border-[#3a3a3c] rounded-md text-[10px] font-mono font-medium text-[#0a84ff] flex items-center justify-between">
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
            className="w-full bg-[#2c2c2e] border border-[#3a3a3c] rounded-lg px-3 py-2 text-xs text-[#ffffff] placeholder-[#8e8e93] focus:outline-none focus:border-[#0a84ff] transition-all font-medium"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-2.5 text-[#8e8e93] hover:text-[#ffffff] text-xs font-bold"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Candidate Card List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 custom-scrollbar">
        {isLoading ? (
          <div className="p-6 text-center text-xs text-[#8e8e93] font-mono animate-pulse">
            Loading candidate records...
          </div>
        ) : filteredCandidates.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#8e8e93]">
            {searchTerm ? (
              <>No candidates matching <span className="font-semibold text-[#ffffff]">"{searchTerm}"</span></>
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
                className={`w-full text-left p-3 rounded-xl transition-all duration-150 relative ${
                  isSelected
                    ? 'bg-[#2c2c2e] border border-[#3a3a3c]'
                    : 'bg-[#1c1c1e] border border-[#2c2c2e] hover:bg-[#2c2c2e]/60'
                }`}
              >
                {/* Top Row: Initials Avatar + ID + Status */}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-[#2c2c2e] text-[#ffffff] border border-[#3a3a3c] flex items-center justify-center text-[10px] font-bold">
                      {initials}
                    </span>
                    <span className="text-[11px] font-mono font-medium text-[#8e8e93] bg-[#2c2c2e] border border-[#3a3a3c] px-1.5 py-0.5 rounded-md">
                      {c.applywizzId}
                    </span>
                  </div>

                  {/* Status Indicator Pill */}
                  {(c.queue_status === 'READY' || (!c.queue_status && c.status === 'READY')) && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#30d158] bg-[#30d158]/15 px-2 py-0.5 rounded-full border border-[#30d158]/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#30d158] animate-pulse"></span>
                      Ready
                    </span>
                  )}
                  {(c.queue_status === 'IN_PROGRESS' ||
                    c.queue_status === 'NO_APPLICATIONS' ||
                    (!c.queue_status && c.status === 'PENDING')) && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#ff9f0a] bg-[#ff9f0a]/15 px-2 py-0.5 rounded-full border border-[#ff9f0a]/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#ff9f0a]"></span>
                      {c.queue_status === 'IN_PROGRESS' ? 'In progress' : 'Pending'}
                    </span>
                  )}
                  {(c.queue_status === 'DONE' || (!c.queue_status && c.status === 'EXPIRED')) && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#8e8e93] bg-[#3a3a3c] px-2 py-0.5 rounded-full border border-[#48484a]">
                      Done
                    </span>
                  )}
                </div>

                {/* Candidate Full Name */}
                <div className="text-xs font-semibold text-[#ffffff] truncate mb-1">
                  {c.clientName}
                </div>

                {/* Bottom Row: Location/Email & Job Count Pill */}
                <div className="flex items-center justify-between text-[11px] text-[#8e8e93]">
                  <span className="truncate max-w-[130px] font-medium text-[#8e8e93]">
                    {c.email || c.location || 'Profile Synced'}
                  </span>

                  <span className="bg-[#2c2c2e] border border-[#3a3a3c] text-[#8e8e93] px-2 py-0.5 rounded-md text-[10px] font-semibold font-mono">
                    {c.job_count ?? c.totalJobs}{' '}
                    {(c.job_count ?? c.totalJobs) === 1 ? 'Job' : 'Jobs'}
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
