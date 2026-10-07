/**
 * @fileoverview Difficulty Badge Component (Apple Music Dark Theme).
 *
 * Renders color-coded difficulty indicators matching the design system:
 * - Easy: Green (#30d158)
 * - Medium: Orange/Amber (#ff9f0a)
 * - Hard: Red (#ff453a)
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
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 ${className}`}
      >
        Easy
      </span>
    );
  }

  if (resolvedLevel === 'Medium') {
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-[#ff9f0a]/15 text-[#ff9f0a] border border-[#ff9f0a]/30 ${className}`}
      >
        Medium
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30 ${className}`}
    >
      Hard
    </span>
  );
};

export default DifficultyBadge;
