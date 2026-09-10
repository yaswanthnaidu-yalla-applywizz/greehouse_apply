/**
 * @fileoverview Editable Form Field React Component with Inline Affordances (Phase V2-UI).
 *
 * Renders individual form fields with neo-brutalist styling matching the reference mockup:
 * - Crisp dark borders (border border-[#1A1A2E])
 * - Distinctive inline source attribution badge (SourceBadge)
 * - Click-to-edit with keyboard shortcuts (Enter to save, Esc to cancel)
 * - Direct asynchronous PATCH /api/applications/:id/fields/:fieldId integration
 */

import React, { useState, useEffect, useRef } from 'react';
import { SourceBadge } from './SourceBadge.js';
import type { ResolvedField } from '../types.js';

export interface EditableFormFieldProps {
  field: ResolvedField;
  applicationId: string;
  onFieldUpdate?: (updatedField: ResolvedField) => void;
}

export const EditableFormField: React.FC<EditableFormFieldProps> = ({
  field,
  applicationId,
  onFieldUpdate,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(field.value || '');
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setValue(field.value || '');
  }, [field.value]);

  useEffect(() => {
    if (isEditing && !isConfirming && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing, isConfirming]);

  useEffect(() => {
    if (isConfirming && confirmBtnRef.current) {
      confirmBtnRef.current.focus();
    }
  }, [isConfirming]);

  const handleRequestSave = () => {
    if (value === (field.value || '')) {
      setIsEditing(false);
      setIsConfirming(false);
      setError(null);
      return;
    }
    setIsConfirming(true);
  };

  const executeSave = async () => {
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/applications/${encodeURIComponent(applicationId)}/fields/${encodeURIComponent(field.fieldId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ value }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error ${response.status}`);
      }

      const updatedField: ResolvedField = await response.json();
      setIsConfirming(false);
      setIsEditing(false);
      if (onFieldUpdate) {
        onFieldUpdate(updatedField);
      }
    } catch (err: any) {
      console.error('Failed to update field:', err);
      setError(err.message || 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setValue(field.value || '');
    setError(null);
    setIsConfirming(false);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancelEdit();
    } else if (e.key === 'Enter' && field.type !== 'textarea') {
      e.preventDefault();
      if (isConfirming) {
        executeSave();
      } else {
        handleRequestSave();
      }
    }
  };

  const isTextarea = field.type === 'textarea';
  const isUnresolved = field.source === 'unresolved';

  return (
    <div
      className={`group relative p-3.5 rounded-lg bg-white transition-all ${
        isUnresolved
          ? 'border-2 border-[#EF4444] shadow-[2px_2px_0px_#EF4444]'
          : 'border border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E]'
      }`}
    >
      {/* Header with Field Label and Badges */}
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex-1">
          <label className="text-xs font-bold text-[#1A1A2E] flex items-center gap-1.5">
            <span>{field.label}</span>
            {field.isRequired && <span className="text-[#EF4444] font-bold">*</span>}
            <span className="text-[10px] font-mono text-[#64748B] font-normal">({field.type})</span>
          </label>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <SourceBadge
            source={field.source}
            confidence={field.confidence}
            isEdited={field.isEdited}
          />

          {!isEditing && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              title="Click to edit field value"
              className="opacity-60 group-hover:opacity-100 p-1 text-[#1A1A2E] hover:bg-[#FAF4EB] border border-transparent hover:border-[#1A1A2E] rounded transition text-xs"
            >
              ✏️
            </button>
          )}
        </div>
      </div>

      {/* Input / Display Area */}
      {isEditing ? (
        <div className="relative mt-1">
          {isTextarea ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving || isConfirming}
              rows={3}
              className="w-full text-xs font-mono p-2.5 bg-[#FFFDF9] border-2 border-[#1A1A2E] rounded-md focus:outline-none focus:ring-2 focus:ring-[#E88474] transition text-[#1A1A2E] disabled:opacity-75"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving || isConfirming}
              className="w-full text-xs font-mono p-2 bg-[#FFFDF9] border-2 border-[#1A1A2E] rounded-md focus:outline-none focus:ring-2 focus:ring-[#E88474] transition text-[#1A1A2E] disabled:opacity-75"
            />
          )}

          {!isConfirming ? (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-200">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRequestSave}
                  disabled={isSaving}
                  className="px-3 py-1 bg-[#10B981] hover:bg-[#059669] text-white font-bold text-xs rounded border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all flex items-center gap-1"
                >
                  <span>💾</span>
                  <span>Save Changes</span>
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="px-2.5 py-1 bg-white hover:bg-gray-100 text-[#1A1A2E] font-medium text-xs rounded border border-gray-300 transition-all"
                >
                  Cancel
                </button>
              </div>
              <span className="text-[10px] text-[#64748B] font-mono">
                Press Enter to save, Esc to cancel
              </span>
            </div>
          ) : (
            <div className="mt-2.5 p-3 rounded-lg bg-[#FEF3C7] border-2 border-[#1A1A2E] shadow-[2px_2px_0px_#1A1A2E] animate-fadeIn">
              <div className="flex items-start gap-2">
                <span className="text-base leading-none">⚠️</span>
                <div className="flex-1">
                  <p className="text-xs font-bold text-[#1A1A2E]">
                    Are you sure you want to update this answer?
                  </p>
                  <div className="mt-2 text-[11px] font-mono space-y-1">
                    <div className="text-[#64748B] flex items-baseline gap-1.5">
                      <span className="font-semibold text-gray-500 shrink-0">Current:</span>
                      <span className="line-through text-[#EF4444] bg-white/80 px-1.5 py-0.5 rounded border border-gray-300 break-all">
                        {field.value || '(empty)'}
                      </span>
                    </div>
                    <div className="text-[#1A1A2E] flex items-baseline gap-1.5">
                      <span className="font-semibold text-gray-700 shrink-0">New:</span>
                      <span className="font-bold text-[#065F46] bg-white px-1.5 py-0.5 rounded border border-[#1A1A2E] break-all">
                        {value || '(empty)'}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      ref={confirmBtnRef}
                      type="button"
                      onClick={executeSave}
                      disabled={isSaving}
                      className="px-3 py-1.5 bg-[#10B981] hover:bg-[#059669] text-white font-bold text-xs rounded border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all flex items-center gap-1 disabled:opacity-50"
                    >
                      {isSaving ? (
                        <span>Saving...</span>
                      ) : (
                        <>
                          <span>✅</span>
                          <span>Yes, Update Answer</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsConfirming(false)}
                      disabled={isSaving}
                      className="px-3 py-1.5 bg-white hover:bg-gray-100 text-[#1A1A2E] font-bold text-xs rounded border border-[#1A1A2E] shadow-[1px_1px_0px_#1A1A2E] active:translate-x-[1px] active:translate-y-[1px] transition-all"
                    >
                      Keep Editing
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      disabled={isSaving}
                      className="px-2 py-1.5 text-xs text-[#64748B] hover:text-[#EF4444] font-medium"
                    >
                      Discard & Cancel
                    </button>
                  </div>
                  {error && <p className="mt-2 text-xs font-bold text-[#EF4444]">{error}</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={() => setIsEditing(true)}
          title="Click to edit answer"
          className="mt-1 p-2 rounded-md bg-[#FAF4EB] border border-[#1A1A2E] hover:bg-[#F5ECE0] cursor-pointer transition text-xs font-mono break-words"
        >
          {field.value && field.value.trim().length > 0 ? (
            <span className="text-[#1A1A2E] font-medium">{field.value}</span>
          ) : (
            <span className="text-[#EF4444] font-bold italic">⚠️ Unresolved field (click to provide answer)</span>
          )}
        </div>
      )}
    </div>
  );
};

export default EditableFormField;
