/**
 * @fileoverview Granular Source Attribution Badge Component for Dashboard.
 *
 * Renders color-coded badges indicating resolution origin:
 * - 'manual': Amber (Operator manual override)
 * - 'unresolved': Rose/Red (Missing or unanswerable)
 * - 'supabase': Emerald (Tier 1 Profile / Exact QA Bank)
 * - 'resume_parse': Cyan (Tier 2 Parsed Resume)
 * - 'fuzzy_match': Blue (Tier 3 Fuzzy Match)
 * - 'api': Indigo (Tier 4 ApplyWizz Refetch)
 * - 'ai': Purple (Tier 5 LLM Synthesis)
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
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-amber-50 text-amber-800 border border-amber-400 shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-600"></span>
        <span>manual</span>
      </span>
    );
  }

  if (activeSource === 'unresolved') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-rose-50 text-rose-800 border border-rose-400 shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-600 animate-pulse"></span>
        <span>unresolved</span>
      </span>
    );
  }

  if (activeSource === 'supabase') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-emerald-50 text-emerald-800 border border-emerald-400 shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>
        <span>supabase</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-emerald-700/80">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'resume_parse') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-cyan-50 text-cyan-800 border border-cyan-400 shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-600"></span>
        <span>resume</span>
      </span>
    );
  }

  if (activeSource === 'fuzzy_match') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-blue-50 text-blue-800 border border-blue-400 shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-600"></span>
        <span>fuzzy</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-blue-700/80">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'api') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-indigo-50 text-indigo-800 border border-indigo-400 shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-600"></span>
        <span>api</span>
      </span>
    );
  }

  // Default: 'ai'
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold font-mono bg-purple-50 text-purple-800 border border-purple-400 shadow-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-purple-600"></span>
      <span>ai</span>
      {confidence !== undefined && (
        <span className="text-[10px] text-purple-700/80">({(confidence * 100).toFixed(0)}%)</span>
      )}
    </span>
  );
};

export default SourceBadge;
