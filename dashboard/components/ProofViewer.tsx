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

import React, { useState, useEffect, useCallback } from 'react';
import { ApplicationStatusBadge } from './ApplicationStatusBadge.js';
import type { ApplicationStatus } from '../../src/db/applications.js';
import { apiFetch, getAccessToken } from '../hooks/useSession.js';

export interface ProofViewerProps {
  isOpen: boolean;
  onClose: () => void;
  screenshotUrl?: string | null;
  applicationId?: string | null;
  kind?: 'web' | 'failed' | 'dryrun' | 'email';
  apiBaseUrl?: string;
  title?: string;
  metadata?: {
    candidateName?: string;
    applywizzId?: string;
    applicationId?: string;
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
  applicationId,
  kind,
  apiBaseUrl = '',
  title = 'Application Verification Proof',
  metadata = {},
}) => {
  const [currentUrl, setCurrentUrl] = useState<string | null>(screenshotUrl || null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fallbackStage, setFallbackStage] = useState<number>(0); // 0: initial, 1: signed_url, 2: proxy_stream, 3: failed

  const fetchSignedUrl = useCallback(
    async (appId: string, proofKind: 'web' | 'failed' | 'dryrun' | 'email', jobUrl?: string) => {
      setIsLoading(true);
      setErrorMessage(null);

      try {
        const query = new URLSearchParams({ kind: proofKind });
        if (jobUrl) query.set('jobUrl', jobUrl);
        const endpoint = `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/proof-url?${query.toString()}`;
        const res = await apiFetch(endpoint);

        if (!res.ok) {
          let errText = `Server returned ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson.error) errText = errJson.error;
          } catch {}
          throw new Error(errText);
        }

        const data = await res.json();
        if (data.url) {
          setCurrentUrl(data.url);
          setFallbackStage(1);
          setIsLoading(false);
          return true;
        } else {
          throw new Error('No signed proof URL returned by server.');
        }
      } catch (err: any) {
        console.warn(`[ProofViewer] Failed to fetch signed proof URL for ${appId}, switching to proxy stream:`, err);
        // Fallback to proxy stream directly
        const query = new URLSearchParams({ kind: proofKind });
        if (jobUrl) query.set('jobUrl', jobUrl);
        const token = getAccessToken();
        if (token) query.set('token', token);
        const proxyUrl = `${apiBaseUrl}/api/applications/${encodeURIComponent(appId)}/proof-image?${query.toString()}`;
        setCurrentUrl(proxyUrl);
        setFallbackStage(2);
        setIsLoading(false);
        return false;
      }
    },
    [apiBaseUrl]
  );

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

  useEffect(() => {
    if (!isOpen) {
      setIsLoading(false);
      setErrorMessage(null);
      setFallbackStage(0);
      return;
    }

    const targetAppId = applicationId || metadata?.applicationId || metadata?.applywizzId;
    const statusStr = String(metadata?.status || '').toUpperCase();
    const effectiveKind: 'web' | 'failed' | 'dryrun' | 'email' =
      kind || (statusStr === 'FAILED' ? 'failed' : title?.includes('Dry-Run') ? 'dryrun' : 'web');

    if (screenshotUrl) {
      setCurrentUrl(screenshotUrl);
      setFallbackStage(0);
      setErrorMessage(null);
      setIsLoading(false);
    } else if (targetAppId) {
      setCurrentUrl(null);
      setFallbackStage(1);
      fetchSignedUrl(targetAppId, effectiveKind, metadata?.jobUrl);
    }
  }, [
    isOpen,
    screenshotUrl,
    applicationId,
    metadata?.applicationId,
    metadata?.applywizzId,
    kind,
    title,
    metadata?.status,
    metadata?.jobUrl,
    fetchSignedUrl,
  ]);

  const handleImageError = () => {
    const targetAppId = applicationId || metadata?.applicationId || metadata?.applywizzId;
    const statusStr = String(metadata?.status || '').toUpperCase();
    const effectiveKind: 'web' | 'failed' | 'dryrun' | 'email' =
      kind || (statusStr === 'FAILED' ? 'failed' : title?.includes('Dry-Run') ? 'dryrun' : 'web');

    if (!targetAppId) {
      setErrorMessage('Proof screenshot could not be loaded (no application ID available).');
      return;
    }

    if (fallbackStage === 0) {
      // The initial screenshotUrl failed (likely expired). Fetch fresh signed URL.
      setFallbackStage(1);
      fetchSignedUrl(targetAppId, effectiveKind, metadata?.jobUrl);
    } else if (fallbackStage === 1) {
      // The signed URL failed to load. Fall back to backend streaming proxy.
      const query = new URLSearchParams({ kind: effectiveKind });
      if (metadata?.jobUrl) query.set('jobUrl', metadata.jobUrl);
      const token = getAccessToken();
      if (token) query.set('token', token);
      const proxyUrl = `${apiBaseUrl}/api/applications/${encodeURIComponent(targetAppId)}/proof-image?${query.toString()}`;
      setCurrentUrl(proxyUrl);
      setFallbackStage(2);
    } else {
      // Both signed URL and proxy stream failed.
      setFallbackStage(3);
      setErrorMessage('Proof screenshot could not be loaded from storage.');
    }
  };

  if (!isOpen) {
    return null;
  }

  const handleDownload = () => {
    if (!currentUrl) return;
    const link = document.createElement('a');
    link.href = currentUrl;
    link.download = `${metadata.applywizzId || applicationId || 'candidate'}_${metadata.companyName || 'proof'}_verification.png`;
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
        className="relative flex flex-col w-full max-w-5xl max-h-[90vh] bg-white rounded-xl border-2 border-[#1A1A2E] overflow-hidden text-[#1A1A2E]"
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
              disabled={!currentUrl || isLoading}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold border border-[#1A1A2E] rounded-md transition-all ${
                !currentUrl || isLoading
                  ? 'bg-[#E2E8F0] text-[#94A3B8] border-[#CBD5E1] cursor-not-allowed'
                  : 'text-white bg-[#E88474] hover:bg-[#D67161] active:translate-x-[1px] active:translate-y-[1px]'
              }`}
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
            {(metadata.candidateName || metadata.applywizzId || applicationId) && (
              <div>
                {metadata.candidateName && (
                  <>
                    <span className="text-[#64748B] font-sans">Candidate: </span>
                    <span className="font-bold text-[#1A1A2E] font-sans">{metadata.candidateName}</span>
                  </>
                )}
                {(metadata.applywizzId || applicationId) && (
                  <span className="ml-1.5 px-2 py-0.5 rounded bg-white border border-[#1A1A2E] text-[#1A1A2E] font-bold">
                    {metadata.applywizzId || applicationId}
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
        <div className="flex-1 overflow-auto p-6 bg-[#FAF4EB] flex items-center justify-center custom-scrollbar min-h-[350px]">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center p-12 text-[#1A1A2E]">
              <div className="w-10 h-10 border-2 border-[#1A1A2E] border-t-transparent rounded-full animate-spin mb-4" />
              <p className="text-sm font-bold font-mono">Fetching signed proof URL...</p>
              <p className="text-xs font-mono text-[#64748B] mt-1">Retrieving secure verification screenshot</p>
            </div>
          ) : errorMessage ? (
            <div className="flex flex-col items-center justify-center p-8 text-center max-w-md bg-white rounded-lg border-2 border-[#1A1A2E]">
              <span className="text-3xl mb-2">⚠️</span>
              <p className="text-sm font-bold text-[#EF4444] font-mono mb-1">Could not load proof</p>
              <p className="text-xs text-[#64748B] font-mono">{errorMessage}</p>
              {(applicationId || metadata?.applywizzId) && (
                <button
                  type="button"
                  onClick={() => {
                    const targetAppId = applicationId || metadata?.applicationId || metadata?.applywizzId;
                    const statusStr = String(metadata?.status || '').toUpperCase();
                    const effectiveKind: 'web' | 'failed' | 'dryrun' | 'email' =
                      kind || (statusStr === 'FAILED' ? 'failed' : title?.includes('Dry-Run') ? 'dryrun' : 'web');
                    setErrorMessage(null);
                    setFallbackStage(1);
                    if (targetAppId) fetchSignedUrl(targetAppId, effectiveKind, metadata?.jobUrl);
                  }}
                  className="mt-4 px-3 py-1.5 text-xs font-bold text-[#1A1A2E] bg-[#FFF5EB] hover:bg-[#FFE8D6] border border-[#1A1A2E] rounded"
                >
                  🔄 Retry
                </button>
              )}
            </div>
          ) : currentUrl ? (
            <div className="bg-white rounded-lg border-2 border-[#1A1A2E] overflow-hidden max-w-full">
              <img
                src={currentUrl}
                alt="Application Confirmation Proof"
                className="w-full h-auto object-contain select-text"
                loading="lazy"
                onError={handleImageError}
              />
            </div>
          ) : (
            <div className="text-center text-xs font-mono text-[#64748B]">
              No proof image available.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t-2 border-[#1A1A2E] bg-[#FAF4EB] text-xs text-[#64748B]">
          <span className="font-mono">Press Esc to exit proof view</span>
          <div className="flex items-center gap-2">
            {currentUrl && (
              <a
                href={currentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-bold text-[#1A1A2E] hover:underline"
              >
                Open raw URL ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProofViewer;
