/**
 * @fileoverview Right Pane Main: Dynamic Form Renderer with Multi-Tier Source Tagging.
 *
 * Renders Greenhouse form questions and answers with strict source attribution badges:
 * - 🟢 `supabase` (emerald-500) for candidate profile / database matches.
 * - 🟣 `ai` (violet-500) for LLM-synthesized responses.
 *
 * All inputs in V1 are readonly for operator review and inspection.
 *
 * References:
 * - 04-ui-ux.md (Section 2.3)
 * - 05-backend-schema.md (Section 1.4)
 */

import React from 'react';
import type { CandidateJobApplication, ResolvedField } from './types.js';

/**
 * Props for FormRenderer component.
 */
export interface FormRendererProps {
  /** Resolved candidate job application payload */
  application: CandidateJobApplication | null;
  /** Loading state */
  isLoading?: boolean;
}

/**
 * Renders the source attribution badge.
 *
 * @param source - 'supabase' or 'ai'
 * @param confidence - Match confidence score (0.0 to 1.0)
 * @returns JSX Element
 */
export const SourceBadge: React.FC<{ source: 'supabase' | 'ai'; confidence?: number }> = ({
  source,
  confidence,
}) => {
  if (source === 'supabase') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold font-mono bg-emerald-950/70 text-emerald-400 border border-emerald-500/40 shadow-sm shadow-emerald-950/50">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
        <span>supabase</span>
        {confidence !== undefined && (
          <span className="text-[10px] text-emerald-500/80">({(confidence * 100).toFixed(0)}%)</span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold font-mono bg-violet-950/70 text-violet-400 border border-violet-500/40 shadow-sm shadow-violet-950/50">
      <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse"></span>
      <span>ai</span>
      {confidence !== undefined && (
        <span className="text-[10px] text-violet-500/80">({(confidence * 100).toFixed(0)}%)</span>
      )}
    </span>
  );
};

/**
 * Dynamic Readonly Form Renderer for Greenhouse Applications.
 *
 * @param props - Component properties.
 * @returns React component.
 */
export const FormRenderer: React.FC<FormRendererProps> = ({
  application,
  isLoading = false,
}) => {
  if (isLoading) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-slate-500">
        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-xs font-mono">Loading resolved application questions...</p>
      </div>
    );
  }

  if (!application) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-slate-500">
        <div className="text-3xl mb-2">📋</div>
        <p className="text-sm font-semibold text-slate-400">No Job Selected</p>
        <p className="text-xs text-slate-600 mt-1">
          Select a candidate and job tab to inspect pre-populated form questions.
        </p>
      </div>
    );
  }

  const supabaseCount = application.resolvedFields.filter((f) => f.source === 'supabase').length;
  const aiCount = application.resolvedFields.filter((f) => f.source === 'ai').length;

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full custom-scrollbar">
      {/* Job Header Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-8 shadow-lg shadow-black/20">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5 mb-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                {application.companyName || 'Greenhouse Posting'}
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-xs font-mono text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">
                {application.applywizzId}
              </span>
            </div>
            <h1 className="text-xl font-bold text-slate-100">
              {application.jobTitle || 'Application Form'}
            </h1>
            <a
              href={application.jobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300 font-mono underline break-all mt-1 inline-block"
            >
              {application.jobUrl}
            </a>
          </div>

          {/* Tag Breakdown Pills */}
          <div className="flex items-center gap-2.5">
            <div className="bg-emerald-950/40 border border-emerald-800/40 px-3 py-2 rounded-lg text-center">
              <div className="text-xs font-mono font-bold text-emerald-400">{supabaseCount}</div>
              <div className="text-[10px] text-emerald-500/80 uppercase tracking-wider">supabase</div>
            </div>
            <div className="bg-violet-950/40 border border-violet-800/40 px-3 py-2 rounded-lg text-center">
              <div className="text-xs font-mono font-bold text-violet-400">{aiCount}</div>
              <div className="text-[10px] text-violet-500/80 uppercase tracking-wider">ai</div>
            </div>
          </div>
        </div>

        {/* Readonly Notice */}
        <div className="bg-slate-950/80 border border-slate-800 rounded-lg px-4 py-2.5 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">🔒</span>
            <span>Readonly Operator Mode (V1) — Pre-populated for verification and QA review</span>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            {application.resolvedFields.length} Form Fields
          </span>
        </div>
      </div>

      {/* Form Fields Section */}
      <div className="space-y-6">
        {application.resolvedFields.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-400">
            <p className="text-sm">No interactive form fields extracted for this job posting.</p>
            {application.status === 'EXPIRED' && (
              <p className="text-xs text-rose-400 mt-1">This job posting appears to be closed or expired.</p>
            )}
          </div>
        ) : (
          application.resolvedFields.map((field: ResolvedField, index: number) => {
            return (
              <div
                key={`${field.fieldId}-${index}`}
                className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all"
              >
                {/* Field Label & Source Badge */}
                <div className="flex items-start justify-between gap-4 mb-3">
                  <label className="text-sm font-semibold text-slate-200 leading-snug">
                    <span className="text-slate-500 font-mono text-xs mr-2">#{index + 1}</span>
                    {field.label || field.name || field.fieldId}
                    {/* Required Asterisk */}
                    <span className="text-rose-500 ml-1 font-bold">*</span>
                  </label>

                  <div className="flex-shrink-0">
                    <SourceBadge source={field.source} confidence={field.confidence} />
                  </div>
                </div>

                {/* Field Input Control (Readonly) */}
                <div className="mt-2">
                  {field.type === 'textarea' ? (
                    <textarea
                      readOnly
                      rows={3}
                      value={field.value || '(No answer provided)'}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 font-sans leading-relaxed focus:outline-none cursor-default resize-none"
                    />
                  ) : field.type === 'file' ? (
                    <div className="flex items-center gap-2 p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 font-mono">
                      <span>📎</span>
                      <span className="truncate">{field.value || 'Master Resume PDF'}</span>
                    </div>
                  ) : field.type === 'select' || field.type === 'radio' ? (
                    <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg flex items-center justify-between text-xs text-slate-200 font-medium">
                      <span>{field.value || '(No option selected)'}</span>
                      <span className="text-[10px] uppercase font-mono text-slate-500 bg-slate-900 px-2 py-0.5 rounded">
                        {field.type}
                      </span>
                    </div>
                  ) : (
                    <input
                      type="text"
                      readOnly
                      value={field.value || ''}
                      placeholder="(Empty)"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-xs text-slate-200 font-sans focus:outline-none cursor-default"
                    />
                  )}
                </div>

                {/* Field Metadata Footer */}
                <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-500 font-mono">
                  <span>ID: {field.fieldId}</span>
                  <span className="capitalize text-slate-500">{field.type}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
