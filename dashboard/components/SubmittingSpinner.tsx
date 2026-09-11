/**
 * @fileoverview Full-width submitting state for live application auto-flow.
 */

import React from 'react';

export interface SubmittingSpinnerProps {
  text?: string;
  className?: string;
}

export const SubmittingSpinner: React.FC<SubmittingSpinnerProps> = ({
  text = 'Submitting...',
  className = '',
}) => (
  <div
    className={`flex items-center justify-center gap-3 px-4 py-3 bg-[#E88474] text-white border-2 border-[#1A1A2E] rounded-xl shadow-[3px_3px_0px_#1A1A2E] animate-pulse ${className}`}
    role="status"
    aria-live="polite"
  >
    <span
      className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin shrink-0"
      aria-hidden="true"
    />
    <span className="text-sm font-bold font-mono tracking-wide">{text}</span>
  </div>
);

export default SubmittingSpinner;
