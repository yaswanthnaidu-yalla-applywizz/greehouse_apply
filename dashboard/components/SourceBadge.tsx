/**
 * @fileoverview Granular Source Attribution Badge Component for Dashboard (Phase V2-UI).
 *
 * Renders crisp, color-coded badges with neo-brutalist dark borders:
 * - 'manual': Amber (#F59E0B)
 * - 'unresolved': Rose/Red (#EF4444)
 * - 'supabase': Emerald (#10B981)
 * - 'resume_parse': Cyan (#06B6D4)
 * - 'fuzzy_match': Blue (#3B82F6)
 * - 'api': Indigo (#6366F1)
 * - 'ai': Purple (#8B5CF6)
 */

import React from 'react';
import type { SourceTag } from '../types.js';

export interface SourceBadgeProps {
  source: SourceTag;
  confidence?: number;
  isEdited?: boolean;
}

export const SourceBadge: React.FC<SourceBadgeProps> = ({
  source,
  confidence,
  isEdited = false,
}) => {
  // If the field has been manually edited by operator, always display the amber 'manual' badge
  const activeSource: SourceTag = isEdited ? 'manual' : source;

  if (activeSource === 'manual') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#FEF3C7] text-[#92400E] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#D97706]"></span>
        <span>manual</span>
      </span>
    );
  }

  if (activeSource === 'unresolved') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#FEE2E2] text-[#991B1B] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse"></span>
        <span>unresolved</span>
      </span>
    );
  }

  if (activeSource === 'supabase') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#D1FAE5] text-[#065F46] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#10B981]"></span>
        <span>supabase</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-[#047857]">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'resume_parse') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#CFFAFE] text-[#155E75] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#06B6D4]"></span>
        <span>resume</span>
      </span>
    );
  }

  if (activeSource === 'fuzzy_match') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#DBEAFE] text-[#1E40AF] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6]"></span>
        <span>fuzzy</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-[#1D4ED8]">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'api') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#E0E7FF] text-[#3730A3] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#6366F1]"></span>
        <span>api</span>
      </span>
    );
  }

  // Default: 'ai'
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#EDE9FE] text-[#5B21B6] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E]">
      <span className="w-1.5 h-1.5 rounded-full bg-[#8B5CF6]"></span>
      <span>ai</span>
      {confidence !== undefined && (
        <span className="text-[10px] text-[#6D28D9]">({(confidence * 100).toFixed(0)}%)</span>
      )}
    </span>
  );
};

export default SourceBadge;
