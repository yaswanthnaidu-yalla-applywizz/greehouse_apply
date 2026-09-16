import React from 'react';
import { operatorFormBlockedDetailMessage } from '../../src/dashboard/candidateQueueFilter.js';

export interface OperatorFormBlockedPanelProps {
  application?: {
    error_message?: string | null;
    errorMessage?: string | null;
    error?: string | null;
  } | null;
}

export const OperatorFormBlockedPanel: React.FC<OperatorFormBlockedPanelProps> = ({ application }) => {
  const detail = operatorFormBlockedDetailMessage(application);

  return (
    <div className="flex-1 p-12 flex flex-col items-center justify-center text-center max-w-md mx-auto w-full">
      <p className="text-base md:text-lg font-bold text-[#1A1A2E] mb-3 leading-snug">
        ⚠️ This application couldn&apos;t be submitted
      </p>
      <p className="text-sm font-mono text-[#64748B] leading-relaxed whitespace-pre-wrap">{detail}</p>
    </div>
  );
};

export default OperatorFormBlockedPanel;
