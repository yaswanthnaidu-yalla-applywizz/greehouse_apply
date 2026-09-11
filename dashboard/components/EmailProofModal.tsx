/**
 * @fileoverview Modal shell for EmailProofRenderer (replaces screenshot proof viewer for mail).
 */

import React, { useEffect } from 'react';
import { EmailProofRenderer, type EmailProofJson } from './EmailProofRenderer.js';

export interface EmailProofModalProps {
  isOpen: boolean;
  onClose: () => void;
  proof: EmailProofJson | null;
  companyName?: string | null;
  metadata?: {
    candidateName?: string;
    applywizzId?: string;
    jobTitle?: string;
  };
}

export const EmailProofModal: React.FC<EmailProofModalProps> = ({
  isOpen,
  onClose,
  proof,
  companyName,
  metadata = {},
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen || !proof) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A2E]/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2 px-1">
          <div className="text-xs font-mono text-white/90">
            {metadata.applywizzId && (
              <span className="font-bold">{metadata.applywizzId}</span>
            )}
            {metadata.jobTitle && <span className="ml-2 opacity-80">{metadata.jobTitle}</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-white hover:bg-white/10 border border-white/30 rounded-md font-bold text-sm"
          >
            ✕
          </button>
        </div>
        <EmailProofRenderer proof={proof} companyName={companyName} />
        <p className="text-center text-[10px] font-mono text-white/70 mt-2">Press Esc to close</p>
      </div>
    </div>
  );
};

export default EmailProofModal;
