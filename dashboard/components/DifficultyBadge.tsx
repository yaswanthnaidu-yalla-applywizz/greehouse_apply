/**
 * @fileoverview Difficulty Badge Component (Phase V2-UI).
 *
 * Renders color-coded difficulty indicators matching reference mockup:
 * - Easy: Green (#9AC89A) with dark border
 * - Medium: Blue (#B8D4E8) with dark border
 * - Hard: Coral (#E88474) with dark border
 */

import React from 'react';

export interface DifficultyBadgeProps {
  /** Number of form fields (used to auto-calculate difficulty level) */
  fieldsCount?: number;
  /** Explicit difficulty level override */
  level?: 'Easy' | 'Medium' | 'Hard';
  /** Optional extra CSS classes */
  className?: string;
}

export function getDifficultyLevel(fieldsCount?: number): 'Easy' | 'Medium' | 'Hard' {
  if (fieldsCount === undefined || fieldsCount === null) return 'Easy';
  if (fieldsCount < 10) return 'Easy';
  if (fieldsCount <= 18) return 'Medium';
  return 'Hard';
}

export const DifficultyBadge: React.FC<DifficultyBadgeProps> = ({
  fieldsCount,
  level,
  className = '',
}) => {
  const resolvedLevel = level || getDifficultyLevel(fieldsCount);

  if (resolvedLevel === 'Easy') {
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-[#9AC89A] text-[#1E4620] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
      >
        Easy
      </span>
    );
  }

  if (resolvedLevel === 'Medium') {
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-[#B8D4E8] text-[#1E3A5F] border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
      >
        Medium
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-[#E88474] text-white border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] ${className}`}
    >
      Hard
    </span>
  );
};
