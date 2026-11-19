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
  jobUrl?: string;
  onFieldUpdate?: (updatedField: ResolvedField) => void;
}

export const EditableFormField: React.FC<EditableFormFieldProps> = ({
  field,
  applicationId,
  jobUrl,
  onFieldUpdate,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(field.value || '');
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const response = await fetch(
        `/api/applications/${encodeURIComponent(applicationId)}/fields/${encodeURIComponent(field.fieldId)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ value, jobUrl }),
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

  const handleFileUpload = async (file: File) => {
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setError('File size exceeds the 10 MB limit.');
      return;
    }

    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!['.pdf', '.docx', '.doc'].includes(ext)) {
      setError('Only .pdf, .docx, and .doc files are permitted.');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64Data = result.includes(',') ? result.split(',')[1] : result;
          resolve(base64Data);
        };
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
      });

      const token = typeof localStorage !== 'undefined' ? localStorage.getItem('applywizz_auth_token') : null;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      const response = await fetch(
        `/api/applications/${encodeURIComponent(applicationId)}/fields/${encodeURIComponent(field.fieldId)}/upload`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            filename: file.name,
            fileBase64: base64,
            mimeType: file.type || (ext === '.pdf' ? 'application/pdf' : 'application/octet-stream'),
            jobUrl,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error ${response.status}`);
      }

      const updatedField: ResolvedField = await response.json();
      setIsEditing(false);
      setValue(updatedField.value || '');
      if (onFieldUpdate) {
        onFieldUpdate(updatedField);
      }
    } catch (err: any) {
      console.error('Failed to upload field document:', err);
      setError(err.message || 'Failed to upload document');
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

  const getHintText = (): string => {
    const type = (field.type || '').toLowerCase();
    if ((type === 'select' || type === 'radio') && field.optionsComplete === false) {
      return 'This question has more options than shown in the application. Please provide as detailed and accurate an answer as possible.';
    }
    if (type === 'select' || type === 'radio' || isChoiceField) {
      return 'This is a dropdown question, please choose from the given options.';
    }
    if (type === 'checkbox') {
      return 'This is a multi-select checkbox question, please select all options that apply.';
    }
    if (type === 'location_autocomplete') {
      return 'Start typing to search and select a city or location from the suggestions.';
    }
    if (type === 'file') {
      return 'Upload the required document.';
    }
    if (type === 'text' || type === 'textarea') {
      return 'Enter a specific answer. Example: years of experience, a number, a short sentence.';
    }
    return 'Provide a clear, specific answer for this field.';
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
  const fieldType = String(field.type || '').toLowerCase();
  const isAvailabilityDate =
    /\b(?:date available to start|available to start|availability date|available date|desired start date|earliest start date|when can you start|when could you start)\b/i.test(
      `${field.label} ${field.name} ${field.fieldId}`
    ) || /^start date$/i.test(field.label.trim());
  const expectedDateFormat = isAvailabilityDate
    ? field.metadata?.expectedDateFormat ||
      (field.type === 'date' || field.metadata?.inputType === 'date' ? 'YYYY-MM-DD' : 'MM/DD/YYYY')
    : null;
  const fieldOptions = Array.isArray(field.options) && field.options.length > 0 ? field.options : null;
  const isIncompleteChoice = (fieldType === 'select' || fieldType === 'radio') && field.optionsComplete === false;
  const isChoiceField = (fieldType === 'select' || fieldType === 'radio') && fieldOptions && !isIncompleteChoice;
  const isCheckbox = fieldType === 'checkbox';
  const isFile = fieldType === 'file';
  const checkboxValues = isCheckbox && value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
  const isRequired = Boolean(field.isRequired || (field as any).required);
  const isUnrequired = !isRequired && !field.value?.trim();
  const isUnresolved = !isUnrequired && field.source === 'unresolved';

  return (
    <div
      className={`group relative p-3.5 rounded-xl bg-[#1c1c1e] transition-all ${
        isUnresolved
          ? 'border border-[#ff453a]/60'
          : 'border border-[#2c2c2e]'
      }`}
    >
      {/* Header with Field Label and Badges */}
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex-1">
          <label className="text-xs font-semibold text-[#ffffff] flex items-center gap-1.5">
            <span>{field.label}</span>
            <button
              data-testid="copy-question"
              type="button"
              onClick={() => navigator.clipboard?.writeText(field.label || '').catch(() => {})}
              className="ml-1 text-[#8e8e93] hover:text-[#0a84ff] text-[10px] leading-none"
              title="Copy question"
            >
              📋
            </button>
            {isRequired && <span className="text-[#ff453a] font-bold">*</span>}
            <span className="text-[10px] font-mono text-[#8e8e93] font-normal">({field.type})</span>
          </label>
          {expectedDateFormat && (
            <p className="mt-1 text-[10px] text-[#8e8e93]">Expected date format: {expectedDateFormat}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <SourceBadge
            source={field.source}
            confidence={field.confidence}
            isEdited={field.isEdited}
            provenance={field.provenance}
            isUnrequired={isUnrequired}
          />

          {!isEditing && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              title="Click to edit field value"
              className="opacity-60 group-hover:opacity-100 px-2 py-1 text-[#8e8e93] hover:text-[#ffffff] hover:bg-[#2c2c2e] border border-transparent hover:border-[#3a3a3c] rounded-md transition text-xs flex items-center gap-1 font-medium"
            >
              <span>edit</span>
              <span aria-hidden>✏️</span>
            </button>
          )}
        </div>
      </div>

      {/* Input / Display Area */}
      {isEditing ? (
        <div className="relative mt-1">
          {showHint && (
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-[#8e8e93] bg-[#2c2c2e] px-2.5 py-1.5 rounded-md border border-[#3a3a3c]">
              <span>💡 {getHintText()}</span>
              <button
                type="button"
                onClick={() => setShowHint(false)}
                className="text-[#8e8e93] hover:text-[#ffffff] font-bold ml-2"
                title="Hide hint"
              >
                ✕
              </button>
            </div>
          )}

          {isFile ? (
            <div className="space-y-2">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  const droppedFile = e.dataTransfer.files?.[0];
                  if (droppedFile) handleFileUpload(droppedFile);
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`p-4 border-2 border-dashed rounded-lg text-center cursor-pointer transition-colors ${
                  isDragging
                    ? 'border-[#0a84ff] bg-[#0a84ff]/10'
                    : 'border-[#3a3a3c] hover:border-[#0a84ff]/60 bg-[#2c2c2e]'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.doc"
                  onChange={(e) => {
                    const selected = e.target.files?.[0];
                    if (selected) handleFileUpload(selected);
                  }}
                  className="hidden"
                  disabled={isSaving}
                />
                <div className="flex flex-col items-center justify-center gap-1.5">
                  <span className="text-2xl">📁</span>
                  <p className="text-xs font-semibold text-[#ffffff]">
                    {isSaving ? 'Uploading document to storage...' : 'Click to browse or drag & drop file here'}
                  </p>
                  <p className="text-[10px] text-[#8e8e93]">Supported: PDF, DOCX, DOC (max 10 MB)</p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="px-2.5 py-1 bg-[#2c2c2e] hover:bg-[#3a3a3c] text-[#8e8e93] hover:text-[#ffffff] font-medium text-xs rounded-md border border-[#3a3a3c] transition-all"
                >
                  Cancel
                </button>
                {isSaving && (
                  <span className="text-[11px] text-[#0a84ff] font-mono animate-pulse">
                    ⏳ Saving to storage...
                  </span>
                )}
              </div>
            </div>
          ) : isChoiceField ? (
            <select
              ref={inputRef as React.RefObject<HTMLSelectElement>}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={isSaving || isConfirming}
              className="w-full text-xs font-mono p-2 bg-[#2c2c2e] border border-[#3a3a3c] rounded-md focus:outline-none focus:border-[#0a84ff] transition text-[#ffffff] disabled:opacity-75"
            >
              <option value="">Select an option...</option>
              {fieldOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : isCheckbox ? (
            fieldOptions ? (
              <div className="space-y-1.5">
                {fieldOptions.map((option) => (
                  <label key={option} className="flex items-center gap-2 text-xs font-mono text-[#ffffff]">
                    <input
                      type="checkbox"
                      checked={checkboxValues.includes(option)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...checkboxValues, option]
                          : checkboxValues.filter((selected) => selected !== option);
                        setValue(next.join(', '));
                      }}
                      disabled={isSaving || isConfirming}
                    />
                    {option}
                  </label>
                ))}
              </div>
            ) : (
              <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                type="checkbox"
                checked={['true', 'yes', 'on', '1'].includes(value.toLowerCase())}
                onChange={(e) => setValue(e.target.checked ? 'true' : 'false')}
                disabled={isSaving || isConfirming}
              />
            )
          ) : isTextarea ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving || isConfirming}
              rows={3}
              className="w-full text-xs font-mono p-2.5 bg-[#2c2c2e] border border-[#3a3a3c] rounded-md focus:outline-none focus:border-[#0a84ff] transition text-[#ffffff] disabled:opacity-75"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving || isConfirming}
              className="w-full text-xs font-mono p-2 bg-[#2c2c2e] border border-[#3a3a3c] rounded-md focus:outline-none focus:border-[#0a84ff] transition text-[#ffffff] disabled:opacity-75"
            />
          )}

          {!isFile && !isConfirming && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#2c2c2e]">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRequestSave}
                  disabled={isSaving}
                  className="px-3 py-1 bg-[#30d158] hover:bg-[#28b84d] text-[#000000] font-semibold text-xs rounded-md transition-all flex items-center gap-1"
                >
                  <span>💾</span>
                  <span>Save Changes</span>
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  className="px-2.5 py-1 bg-[#2c2c2e] hover:bg-[#3a3a3c] text-[#8e8e93] hover:text-[#ffffff] font-medium text-xs rounded-md border border-[#3a3a3c] transition-all"
                >
                  Cancel
                </button>
              </div>
              <span className="text-[10px] text-[#8e8e93] font-mono">
                Press Enter to save, Esc to cancel
              </span>
            </div>
          )}

          {!isFile && isConfirming && (
            <div className="mt-2.5 p-3 rounded-lg bg-[#2c2c2e] border border-[#ff9f0a]/40 animate-fadeIn">
              <div className="flex items-start gap-2">
                <span className="text-base leading-none">⚠️</span>
                <div className="flex-1">
                  <p className="text-xs font-semibold text-[#ffffff]">
                    Are you sure you want to update this answer?
                  </p>
                  <div className="mt-2 text-[11px] font-mono space-y-1">
                    <div className="text-[#8e8e93] flex items-baseline gap-1.5">
                      <span className="font-semibold text-[#8e8e93] shrink-0">Current:</span>
                      <span className="line-through text-[#ff453a] bg-[#1c1c1e] px-1.5 py-0.5 rounded border border-[#3a3a3c] break-all">
                        {field.value || '(empty)'}
                      </span>
                    </div>
                    <div className="text-[#ffffff] flex items-baseline gap-1.5">
                      <span className="font-semibold text-[#8e8e93] shrink-0">New:</span>
                      <span className="font-bold text-[#30d158] bg-[#1c1c1e] px-1.5 py-0.5 rounded border border-[#3a3a3c] break-all">
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
                      className="px-3 py-1.5 bg-[#30d158] hover:bg-[#28b84d] text-[#000000] font-semibold text-xs rounded-md transition-all flex items-center gap-1 disabled:opacity-50"
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
                      className="px-3 py-1.5 bg-[#1c1c1e] hover:bg-[#2c2c2e] text-[#ffffff] font-medium text-xs rounded-md border border-[#3a3a3c] transition-all"
                    >
                      Keep Editing
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      disabled={isSaving}
                      className="px-2 py-1.5 text-xs text-[#8e8e93] hover:text-[#ff453a] font-medium"
                    >
                      Discard & Cancel
                    </button>
                  </div>
                  {error && <p className="mt-2 text-xs font-semibold text-[#ff453a]">{error}</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : isFile ? (
        <div
          onClick={() => setIsEditing(true)}
          title="Click to upload or replace file"
          className="mt-1 p-2.5 rounded-lg bg-[#2c2c2e] border border-[#3a3a3c] hover:border-[#0a84ff]/60 hover:bg-[#3a3a3c]/60 cursor-pointer transition text-xs font-mono flex items-center justify-between"
        >
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="text-base shrink-0">📄</span>
            {field.value && field.value.trim().length > 0 ? (
              <div className="flex flex-col min-w-0">
                <span className="text-[#ffffff] font-medium truncate">
                  {field.metadata?.filename || field.value.split(/[/\\]/).pop() || field.value}
                </span>
                <span className="text-[10px] text-[#8e8e93]">
                  {field.metadata?.size ? `${(field.metadata.size / 1024).toFixed(1)} KB • ` : ''}
                  {field.metadata?.isOperatorUploaded ? 'Operator Uploaded' : 'Uploaded document'}
                </span>
              </div>
            ) : isUnrequired ? (
              <span className="text-[#8e8e93] font-semibold italic">Unrequired (click to upload file)</span>
            ) : (
              <span className="text-[#ff453a] font-semibold italic">⚠️ Unresolved document (click to upload .pdf, .docx)</span>
            )}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsEditing(true);
            }}
            className="ml-2 px-2.5 py-1 bg-[#3a3a3c] hover:bg-[#48484a] text-[#ffffff] text-[11px] rounded border border-[#545458] transition shrink-0 font-medium"
          >
            {field.value ? 'Replace' : 'Upload'}
          </button>
        </div>
      ) : (
        <div
          onClick={() => setIsEditing(true)}
          title="Click to edit answer"
          className="mt-1 p-2 rounded-md bg-[#2c2c2e] border border-[#3a3a3c] hover:border-[#48484a] hover:bg-[#3a3a3c]/60 cursor-pointer transition text-xs font-mono break-words"
        >
          {field.value && field.value.trim().length > 0 ? (
            <span className="text-[#ffffff] font-medium">{field.value}</span>
          ) : (
            isUnrequired ? (
              <span className="text-[#8e8e93] font-semibold italic">Unrequired (click to provide answer)</span>
            ) : (
              <span className="text-[#ff453a] font-semibold italic">⚠️ Unresolved field (click to provide answer)</span>
            )
          )}
        </div>
      )}
    </div>
  );
};

export default EditableFormField;
