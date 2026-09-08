/**
 * @fileoverview Right Pane Main: Dynamic Form Renderer with Inline Edit Affordance (Phase V2-3).
 *
 * Renders Greenhouse form questions with multi-tier source attribution badges:
 * - 🟢 `supabase` (Emerald) for profile & exact QA bank matches.
 * - 🔵 `resume_parse` (Cyan) for parsed resume matches.
 * - 🔷 `fuzzy_match` (Blue) for fuzzy QA bank matches.
 * - 🟣 `api` (Indigo) for ApplyWizz API live refetch matches.
 * - 🟣 `ai` (Purple) for LLM-synthesized responses.
 * - 🟡 `manual` (Amber) for operator manual edits.
 * - 🔴 `unresolved` (Rose) for unresolved fields.
 *
 * Supports inline editing: clicking any field or ✏️ affordance allows editing,
 * auto-submits PATCH /api/applications/:id/fields/:fieldId, and updates candidate_qa_bank.
 */

import React from 'react';
import { EditableFormField } from './components/EditableFormField.js';
import { SourceBadge } from './components/SourceBadge.js';
import type { CandidateJobApplication, ResolvedField } from './types.js';

export { SourceBadge };

export interface FormRendererProps {
  /** Resolved candidate job application payload */
  application: CandidateJobApplication | null;
  /** Loading state */
  isLoading?: boolean;
  /** Callback fired when an operator manually modifies a field */
  onFieldUpdate?: (updatedField: ResolvedField) => void;
}

export const FormRenderer: React.FC<FormRendererProps> = ({
  application,
  isLoading = false,
  onFieldUpdate,
}) => {
  if (isLoading) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-[#64748B]">
        <div className="w-8 h-8 border-2 border-[#059669] border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-xs font-mono">Loading application form...</p>
      </div>
    );
  }

  if (!application) {
    return (
      <div className="flex-1 p-12 flex flex-col items-center justify-center text-[#64748B]">
        <div className="text-3xl mb-2">📋</div>
        <p className="text-sm font-semibold text-[#1E293B]">No Job Selected</p>
        <p className="text-xs text-[#64748B] mt-1">
          Select a candidate and job tab to inspect and edit pre-populated form questions.
        </p>
      </div>
    );
  }

  const manualCount = application.resolvedFields.filter((f) => f.isEdited || f.source === 'manual').length;
  const supabaseCount = application.resolvedFields.filter((f) => f.source === 'supabase' && !f.isEdited).length;
  const aiCount = application.resolvedFields.filter((f) => f.source === 'ai' && !f.isEdited).length;
  const unresCount = application.resolvedFields.filter((f) => f.source === 'unresolved').length;

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto w-full custom-scrollbar">
      {/* Job Header Card */}
      <div className="bg-[#FFFFFF] border border-[#E8DCCF] rounded-xl p-6 mb-8 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#E8DCCF] pb-5 mb-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-[#64748B]">
                {application.companyName || 'Greenhouse Posting'}
              </span>
              <span className="text-[#CBD5E1]">•</span>
              <span className="text-xs font-mono text-[#059669] bg-[#FAF6F0] px-2 py-0.5 rounded border border-[#9AC89A]">
                {application.applywizzId}
              </span>
            </div>
            <h1 className="text-xl font-bold text-[#0F172A]">
              {application.jobTitle || 'Application Form'}
            </h1>
            <a
              href={application.jobUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#0284C7] hover:text-[#0369A1] font-mono underline break-all mt-1 inline-block"
            >
              {application.jobUrl}
            </a>
          </div>

          {/* Tag Breakdown Pills */}
          <div className="flex items-center gap-2 flex-wrap">
            {manualCount > 0 && (
              <div className="bg-amber-50 border border-amber-300 px-3 py-1.5 rounded-xl text-center">
                <div className="text-xs font-mono font-bold text-amber-800">{manualCount}</div>
                <div className="text-[10px] text-amber-700 uppercase tracking-wider font-semibold">manual</div>
              </div>
            )}
            <div className="bg-[#9AC89A]/30 border border-[#9AC89A] px-3 py-1.5 rounded-xl text-center">
              <div className="text-xs font-mono font-bold text-[#2D5C2D]">{supabaseCount}</div>
              <div className="text-[10px] text-[#2D5C2D] uppercase tracking-wider font-semibold">supabase</div>
            </div>
            <div className="bg-[#8B5CF6]/15 border border-[#8B5CF6]/40 px-3 py-1.5 rounded-xl text-center">
              <div className="text-xs font-mono font-bold text-[#6D28D9]">{aiCount}</div>
              <div className="text-[10px] text-[#6D28D9] uppercase tracking-wider font-semibold">ai</div>
            </div>
            {unresCount > 0 && (
              <div className="bg-rose-50 border border-rose-300 px-3 py-1.5 rounded-xl text-center">
                <div className="text-xs font-mono font-bold text-rose-800">{unresCount}</div>
                <div className="text-[10px] text-rose-700 uppercase tracking-wider font-semibold">unresolved</div>
              </div>
            )}
          </div>
        </div>

        {/* Interactive Mode Banner */}
        <div className="bg-[#FAF6F0] border border-[#E8DCCF] rounded-lg px-4 py-2.5 flex items-center justify-between text-xs text-[#64748B]">
          <div className="flex items-center gap-2">
            <span className="text-amber-600">✏️</span>
            <span>Interactive Operator Review (V2) — Click any field or ✏️ to edit answers inline</span>
          </div>
          <span className="text-[11px] font-mono text-[#64748B]">
            {application.resolvedFields.length} Form Fields
          </span>
        </div>
      </div>

      {/* Form Fields Section */}
      <div className="space-y-4">
        {application.resolvedFields.length === 0 ? (
          <div className="bg-[#FFFFFF] border border-[#E8DCCF] rounded-xl p-8 text-center text-[#64748B] shadow-sm">
            <p className="text-sm">No interactive form fields extracted for this job posting.</p>
            {application.status === 'EXPIRED' && (
              <p className="text-xs text-[#E11D48] mt-1">This job posting appears to be closed or expired.</p>
            )}
          </div>
        ) : (
          application.resolvedFields.map((field: ResolvedField, index: number) => {
            const applicationId = application.applywizzId || 'app-default';
            return (
              <EditableFormField
                key={`${field.fieldId}-${index}`}
                field={field}
                applicationId={applicationId}
                onFieldUpdate={onFieldUpdate}
              />
            );
          })
        )}
      </div>
    </div>
  );
};

export default FormRenderer;
