/**
 * @fileoverview Renders stored confirmation email proof as a styled card (no screenshots).
 */

import React, { useMemo } from 'react';

export interface EmailProofJson {
  from: string;
  subject: string;
  received_at: string;
  body_text: string;
}

export interface EmailProofRendererProps {
  proof: EmailProofJson;
  companyName?: string | null;
  className?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatReceivedAt(isoOrText: string): string {
  const d = new Date(isoOrText);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return isoOrText;
}

function renderBodyPreview(body: string, companyName?: string | null): React.ReactNode {
  const normalized = (body || '').replace(/\s+/g, ' ').trim();
  const preview = normalized.length > 4000 ? `${normalized.slice(0, 4000)}…` : normalized;

  if (!companyName || companyName.trim().length < 2) {
    return <span className="whitespace-pre-wrap break-words">{preview}</span>;
  }

  const parts = preview.split(new RegExp(`(${escapeRegExp(companyName.trim())})`, 'gi'));
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) =>
        part.toLowerCase() === companyName.trim().toLowerCase() ? (
          <strong key={index} className="font-bold text-[#1A1A2E] bg-[#FEF3C7] px-0.5 rounded">
            {part}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </span>
  );
}

export const EmailProofRenderer: React.FC<EmailProofRendererProps> = ({
  proof,
  companyName,
  className = '',
}) => {
  const receivedLabel = useMemo(() => formatReceivedAt(proof.received_at), [proof.received_at]);

  return (
    <article
      className={`bg-white border-2 border-[#1A1A2E] rounded-xl shadow-[4px_4px_0px_#1A1A2E] overflow-hidden text-[#1A1A2E] ${className}`}
    >
      <header className="px-5 py-4 bg-[#EFF6FF] border-b-2 border-[#1A1A2E]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#64748B] font-mono mb-1">
              Confirmation email proof
            </p>
            <h3 className="text-sm font-bold leading-snug break-words">{proof.subject || '(No subject)'}</h3>
          </div>
          <span className="shrink-0 text-[10px] font-mono font-bold text-[#1E3A8A] bg-white border border-[#1A1A2E] px-2 py-1 rounded">
            📧 Verified
          </span>
        </div>
        <dl className="mt-3 space-y-1 text-xs font-mono">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-[#64748B]">From</dt>
            <dd className="font-bold text-[#1A1A2E] break-all">{proof.from || 'Unknown sender'}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-[#64748B]">Received</dt>
            <dd className="text-[#1A1A2E]">{receivedLabel}</dd>
          </div>
        </dl>
      </header>
      <div className="px-5 py-4 bg-[#FAF4EB] max-h-[min(50vh,420px)] overflow-y-auto custom-scrollbar">
        <p className="text-xs leading-relaxed text-[#334155]">{renderBodyPreview(proof.body_text, companyName)}</p>
      </div>
    </article>
  );
};

export default EmailProofRenderer;
