/**
 * @fileoverview Granular Source Attribution Badge Component for Dashboard (Apple Music Dark Theme).
 *
 * Source badges:
 * - 'supabase': Blue (#0a84ff)
 * - 'ai': Cyan/Light Blue (#5ac8fa)
 * - 'manual': Accent Blue (#0071e3)
 * - 'unresolved': Red (#ff453a)
 * - 'resume_parse', 'fuzzy_match', 'semantic', 'api': Cohesive dark sub-tones
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
  // If the field has been manually edited by operator, always display the manual badge
  const activeSource: SourceTag = isEdited ? 'manual' : source;

  if (activeSource === 'manual') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#0071e3]/15 text-[#0071e3] border border-[#0071e3]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0071e3]"></span>
        <span>manual</span>
      </span>
    );
  }

  if (activeSource === 'unresolved') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#ff453a] animate-pulse"></span>
        <span>unresolved</span>
      </span>
    );
  }

  if (activeSource === 'supabase') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0a84ff]"></span>
        <span>supabase</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-[#0a84ff]/80">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'resume_parse') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#5ac8fa]/15 text-[#5ac8fa] border border-[#5ac8fa]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#5ac8fa]"></span>
        <span>resume</span>
      </span>
    );
  }

  if (activeSource === 'fuzzy_match') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0a84ff]"></span>
        <span>fuzzy</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-[#0a84ff]/80">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'semantic') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#5ac8fa]/15 text-[#5ac8fa] border border-[#5ac8fa]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#5ac8fa]"></span>
        <span>semantic</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-[#5ac8fa]/80">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  if (activeSource === 'api') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/30">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0a84ff]"></span>
        <span>api</span>
      </span>
    );
  }

  // Default: 'ai'
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-[#5ac8fa]/15 text-[#5ac8fa] border border-[#5ac8fa]/30">
      <span className="w-1.5 h-1.5 rounded-full bg-[#5ac8fa]"></span>
      <span>ai</span>
      {confidence !== undefined && (
        <span className="text-[10px] text-[#5ac8fa]/80">({(confidence * 100).toFixed(0)}%)</span>
      )}
    </span>
  );
};

export default SourceBadge;
