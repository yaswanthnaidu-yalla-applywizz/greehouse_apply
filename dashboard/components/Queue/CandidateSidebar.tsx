import React from 'react';
import { CandidateList } from '../../CandidateList.js';
import type { CandidateSummary } from '../../types.js';

export interface CandidateSidebarProps {
  candidates: CandidateSummary[];
  selectedId: string | null;
  onSelectCandidate: (id: string) => void;
  isLoading?: boolean;
  emptyMessage?: string | null;
  selectedDate?: string;
}

export const CandidateSidebar: React.FC<CandidateSidebarProps> = ({
  candidates,
  selectedId,
  onSelectCandidate,
  isLoading,
  emptyMessage,
  selectedDate,
}) => {
  return (
    <CandidateList
      candidates={candidates}
      selectedId={selectedId}
      onSelectCandidate={onSelectCandidate}
      isLoading={isLoading}
      emptyMessage={emptyMessage}
      selectedDate={selectedDate}
    />
  );
};
