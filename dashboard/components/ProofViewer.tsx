/**
 * @fileoverview Interactive Proof & Screenshot Viewer Modal (Phase V2-5).
 *
 * Displays full-page confirmation proofs or dry-run screenshots with high-res zoom,
 * downloadable image assets, and application metadata.
 *
 * References:
 * - 04-ui-ux.md
 * - V2-implementation.md (Phase V2-5)
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden text-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50/80">
          <div className="flex items-center gap-3">
            <span className="text-xl">📸</span>
            <div>
              <h2 className="text-base font-bold text-slate-900">{title}</h2>
              <p className="text-xs font-mono text-slate-500">
                {metadata.companyName ? `${metadata.companyName} — ` : ''}
                {metadata.jobTitle || 'Greenhouse Application'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {metadata.status && (
              <ApplicationStatusBadge status={metadata.status} />
            )}

            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors"
            >
              <span>⬇️</span>
              <span>Download Image</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-lg transition"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Metadata Banner */}
        <div className="px-6 py-3 bg-[#FFF5EB] border-b border-[#E8DCCF] flex flex-wrap items-center justify-between gap-4 text-xs font-mono text-slate-700">
          <div className="flex items-center gap-4 flex-wrap">
            {metadata.candidateName && (
              <div>
                <span className="text-slate-500 font-sans">Candidate: </span>
                <span className="font-bold text-slate-900 font-sans">{metadata.candidateName}</span>
                {metadata.applywizzId && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded bg-[#FAF6F0] border border-[#D8C7B5] text-[#059669]">
                    {metadata.applywizzId}
                  </span>
                )}
              </div>
            )}

            {metadata.capturedAt && (
              <div>
                <span className="text-slate-500 font-sans">Captured: </span>
                <span className="text-slate-800">{formattedDate}</span>
              </div>
            )}
          </div>

          {metadata.jobUrl && (
            <a
              href={metadata.jobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-sky-600 hover:text-sky-800 underline truncate max-w-xs"
            >
              {metadata.jobUrl}
            </a>
          )}
        </div>

        {/* Screenshot Viewport */}
        <div className="flex-1 overflow-auto p-6 bg-slate-900/5 flex justify-center custom-scrollbar">
          <div className="bg-white rounded-xl shadow-md border border-slate-200 overflow-hidden max-w-full">
            <img
              src={screenshotUrl}
              alt="Application Confirmation Proof"
              className="w-full h-auto object-contain select-text"
              loading="lazy"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-500">
          <span className="font-mono">Press Esc to exit proof view</span>
          <div className="flex items-center gap-2">
            <a
              href={screenshotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold text-slate-700 hover:text-slate-900 hover:underline"
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
