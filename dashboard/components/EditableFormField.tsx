/**
 * @fileoverview Editable Form Field React Component with Inline Affordances (Phase V2-3).
 *
 * Provides:
 * - Hover ✏️ edit affordance
 * - Interactive input/textarea toggle
 * - Keyboard shortcuts: Enter/Blur to save, Escape to cancel
 * - Asynchronous PATCH /api/applications/:id/fields/:fieldId submission
 * - Instant transition to amber 'manual' badge on successful update
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

  return (
    <div className="group relative p-4 rounded-xl border border-slate-200/90 hover:border-slate-300 bg-white transition-all shadow-sm">
      {/* Header with Field Label and Badges */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1">
          <label className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
            <span>{field.label}</span>
            <span className="text-[10px] font-mono text-slate-400 font-normal">({field.type})</span>
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
              className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition text-xs"
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
              className="w-full text-xs font-mono p-2.5 bg-amber-50/20 border-2 border-amber-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-200 transition text-slate-900"
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
              className="w-full text-xs font-mono p-2 bg-amber-50/20 border-2 border-amber-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-200 transition text-slate-900"
            />
          )}

          <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400 font-mono">
            <span>Press Enter to save, Esc to cancel</span>
            {isSaving && <span className="text-amber-600 font-semibold animate-pulse">Saving...</span>}
            {error && <span className="text-rose-600 font-semibold">{error}</span>}
          </div>
        </div>
      ) : (
        <div
          onClick={() => setIsEditing(true)}
          title="Click to edit"
          className="mt-1 p-2.5 rounded-lg bg-slate-50/80 border border-slate-100 hover:bg-slate-100/80 cursor-pointer transition text-xs font-mono break-words"
        >
          {field.value && field.value.trim().length > 0 ? (
            <span className="text-slate-900">{field.value}</span>
          ) : (
            <span className="text-slate-400 italic">No answer provided (click to edit)</span>
          )}
        </div>
      )}
    </div>
  );
};

export default EditableFormField;
