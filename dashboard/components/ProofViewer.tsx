/**
 * @fileoverview Interactive Proof & Screenshot Viewer Modal (Phase V2-UI).
 *
 * Displays full-page confirmation proofs or dry-run screenshots with high-res zoom,
 * downloadable image assets, and application metadata in neo-brutalist styling.
 *
 * References:
 * - 04-ui-ux-v2-refined.md
 * - V2-implementation.md (Phase V2-5, V2-UI)
 */

import React, { useEffect } from 'react';
import { ApplicationStatusBadge } from './ApplicationStatusBadge.js';
import type { ApplicationStatus } from '../../src/db/applications.js';

export interface ProofViewerProps {
  isOpen: boolean;
  onClose: () => void;
  screenshotUrl: string | null;
  title?: string;
  metadata?: {
    candidateName?: string;
    applywizzId?: string;
    companyName?: string;
    jobTitle?: string;
    jobUrl?: string;
    capturedAt?: string | null;
    status?: ApplicationStatus | string;
  };
}

export const ProofViewer: React.FC<ProofViewerProps> = ({
  isOpen,
  onClose,
  screenshotUrl,
  title = 'Application Verification Proof',
  metadata = {},
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen || !screenshotUrl) {
    return null;
  }

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = screenshotUrl;
    link.download = `${metadata.applywizzId || 'candidate'}_${metadata.companyName || 'proof'}_verification.png`;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formattedDate = metadata.capturedAt
    ? new Date(metadata.capturedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      })
    : 'Recently captured';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1A1A2E]/80 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-5xl max-h-[90vh] bg-white rounded-xl shadow-[8px_8px_0px_#1A1A2E] border-2 border-[#1A1A2E] overflow-hidden text-[#1A1A2E]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-[#1A1A2E] bg-[#FAF4EB]">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📸</span>
            <div>
              <h2 className="text-base font-bold text-[#1A1A2E]">{title}</h2>
              <p className="text-xs font-mono text-[#64748B]">
                {metadata.companyName ? `${metadata.companyName} — ` : ''}
                {metadata.jobTitle || 'Greenhouse Application'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {metadata.status && <ApplicationStatusBadge status={metadata.status} />}

            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-[#E88474] hover:bg-[#D67161] border border-[#1A1A2E] rounded-md shadow-[2px_2px_0px_#1A1A2E] transition-all"
            >
              <span>⬇️</span>
              <span>Download Image</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-[#1A1A2E] hover:bg-[#E8DCCF] border border-[#1A1A2E] rounded-md transition font-bold"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Metadata Banner */}
        <div className="px-6 py-3 bg-[#FFF5EB] border-b border-[#1A1A2E] flex flex-wrap items-center justify-between gap-4 text-xs font-mono text-[#1A1A2E]">
          <div className="flex items-center gap-4 flex-wrap">
            {metadata.candidateName && (
              <div>
                <span className="text-[#64748B] font-sans">Candidate: </span>
                <span className="font-bold text-[#1A1A2E] font-sans">{metadata.candidateName}</span>
                {metadata.applywizzId && (
                  <span className="ml-1.5 px-2 py-0.5 rounded bg-white border border-[#1A1A2E] text-[#1A1A2E] font-bold">
                    {metadata.applywizzId}
                  </span>
                )}
              </div>
            )}

            {metadata.capturedAt && (
              <div>
                <span className="text-[#64748B] font-sans">Captured: </span>
                <span className="text-[#1A1A2E]">{formattedDate}</span>
              </div>
            )}
          </div>

          {metadata.jobUrl && (
            <a
              href={metadata.jobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#2563EB] hover:underline font-bold truncate max-w-xs"
            >
              {metadata.jobUrl}
            </a>
          )}
        </div>

        {/* Screenshot Viewport */}
        <div className="flex-1 overflow-auto p-6 bg-[#FAF4EB] flex justify-center custom-scrollbar">
          <div className="bg-white rounded-lg border-2 border-[#1A1A2E] shadow-[4px_4px_0px_#1A1A2E] overflow-hidden max-w-full">
            <img
              src={screenshotUrl}
              alt="Application Confirmation Proof"
              className="w-full h-auto object-contain select-text"
              loading="lazy"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t-2 border-[#1A1A2E] bg-[#FAF4EB] text-xs text-[#64748B]">
          <span className="font-mono">Press Esc to exit proof view</span>
          <div className="flex items-center gap-2">
            <a
              href={screenshotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-bold text-[#1A1A2E] hover:underline"
            >
              Open raw URL ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProofViewer;
