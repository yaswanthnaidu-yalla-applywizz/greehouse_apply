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
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(field.value || '');
  }, [field.value]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (value === field.value && !error) {
      setIsEditing(false);
      return;
    }

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setValue(field.value || '');
      setError(null);
      setIsEditing(false);
    } else if (e.key === 'Enter' && field.type !== 'textarea') {
      e.preventDefault();
      handleSave();
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
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              disabled={isSaving}
              rows={3}
              className="w-full text-xs font-mono p-2.5 bg-[#FFFDF9] border-2 border-[#1A1A2E] rounded-md focus:outline-none focus:ring-2 focus:ring-[#E88474] transition text-[#1A1A2E]"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              disabled={isSaving}
              className="w-full text-xs font-mono p-2 bg-[#FFFDF9] border-2 border-[#1A1A2E] rounded-md focus:outline-none focus:ring-2 focus:ring-[#E88474] transition text-[#1A1A2E]"
            />
          )}

          <div className="flex items-center justify-between mt-1 text-[10px] text-[#64748B] font-mono">
            <span>Press Enter to save, Esc to cancel</span>
            {isSaving && <span className="text-[#D97706] font-bold animate-pulse">Saving...</span>}
            {error && <span className="text-[#EF4444] font-bold">{error}</span>}
          </div>
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
