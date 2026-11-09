/**
 * @fileoverview Manager Review Tab Component.
 *
 * Fetches pending AI answer reviews awaiting manager verification via GET /api/reviews/manager.
 * Displays original AI proposal alongside operator action and values.
 * Allows manager to approve, edit, or reject.
 * Enforces business rule: If operator denied, direct approve is disabled (or requires replacement edit).
 * On 409 Conflict, displays stale revision warning and reloads queue.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../hooks/useSession.js';
import {
  type ReviewItem,
  buildManagerActionPayload,
  isManagerDirectApproveAllowed,
  isStaleRevisionResponse,
  validateManagerAction,
} from '../utils/reviewClient.js';

export interface ManagerReviewTabProps {
  className?: string;
}

export const ManagerReviewTab: React.FC<ManagerReviewTabProps> = ({ className = '' }) => {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [submittingIds, setSubmittingIds] = useState<Record<string, boolean>>({});
  const [conflictErrors, setConflictErrors] = useState<Record<string, string>>({});
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState<string>('');
  const [editError, setEditError] = useState<string | null>(null);

  const fetchReviews = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reviews/manager');
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch manager reviews');
      }
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
    } catch (err: any) {
      setError(err?.message || 'Error loading manager review queue');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const handleStartEdit = (item: ReviewItem) => {
    setEditingCardId(item.id);
    // Prefill with operator value if present, else AI value
    setEditedValue(item.operator_value || item.ai_value || '');
    setEditError(null);
    setConflictErrors((prev) => {
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });
  };

  const handleCancelEdit = () => {
    setEditingCardId(null);
    setEditedValue('');
    setEditError(null);
  };

  const handleAction = async (item: ReviewItem, action: 'approve' | 'reject') => {
    if (action === 'approve' && !isManagerDirectApproveAllowed(item.operator_action)) {
      setConflictErrors((prev) => ({
        ...prev,
        [item.id]: 'Operator denied this proposal. Please click Edit to provide a replacement value before approving.',
      }));
      return;
    }

    setSubmittingIds((prev) => ({ ...prev, [item.id]: true }));
    setConflictErrors((prev) => {
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });

    try {
      const payload = buildManagerActionPayload(action, item.revision, undefined, undefined, item.operator_action);
      const res = await apiFetch(`/api/reviews/${encodeURIComponent(item.id)}/manager-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (isStaleRevisionResponse(res.status)) {
        setConflictErrors((prev) => ({
          ...prev,
          [item.id]: 'Conflict: This item has been modified in another session (stale revision). Refreshing queue…',
        }));
        await fetchReviews();
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Failed to ${action} review`);
      }

      // Success
      setReviews((prev) => prev.filter((r) => r.id !== item.id));
    } catch (err: any) {
      setConflictErrors((prev) => ({
        ...prev,
        [item.id]: err?.message || `Failed to submit ${action} action`,
      }));
    } finally {
      setSubmittingIds((prev) => ({ ...prev, [item.id]: false }));
    }
  };

  const handleSubmitEdit = async (item: ReviewItem) => {
    const validation = validateManagerAction('edit', item.operator_action, editedValue);
    if (!validation.valid) {
      setEditError(validation.error || 'Replacement value cannot be empty');
      return;
    }

    setSubmittingIds((prev) => ({ ...prev, [item.id]: true }));
    setEditError(null);

    try {
      const payload = buildManagerActionPayload('edit', item.revision, editedValue, undefined, item.operator_action);
      const res = await apiFetch(`/api/reviews/${encodeURIComponent(item.id)}/manager-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (isStaleRevisionResponse(res.status)) {
        setConflictErrors((prev) => ({
          ...prev,
          [item.id]: 'Conflict: This item has been modified in another session (stale revision). Refreshing queue…',
        }));
        await fetchReviews();
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit edited review');
      }

      // Success
      setEditingCardId(null);
      setEditedValue('');
      setReviews((prev) => prev.filter((r) => r.id !== item.id));
    } catch (err: any) {
      setEditError(err?.message || 'Failed to submit edit');
    } finally {
      setSubmittingIds((prev) => ({ ...prev, [item.id]: false }));
    }
  };

  return (
    <div className={`p-4 md:p-6 max-w-5xl mx-auto w-full font-sans text-white ${className}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 pb-4 border-b border-[#2c2c2e]">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl md:text-2xl font-bold tracking-tight text-white">Manager Review Queue</h2>
            {!isLoading && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-[#2c2c2e] text-[#8e8e93]">
                {reviews.length} {reviews.length === 1 ? 'item' : 'items'}
              </span>
            )}
          </div>
          <p className="text-xs text-[#8e8e93] font-mono mt-1">
            Review and finalize operator decisions on AI-generated candidate answers.
          </p>
        </div>

        <button
          type="button"
          onClick={fetchReviews}
          disabled={isLoading}
          className="self-start sm:self-auto px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#2c2c2e] bg-[#1c1c1e] text-[#8e8e93] hover:text-white hover:bg-[#2c2c2e] transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          <span className={isLoading ? 'animate-spin inline-block' : ''}>🔄</span>
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 bg-[#ff453a]/15 border border-[#ff453a]/40 rounded-xl p-4 text-sm font-semibold text-[#ff453a] flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={fetchReviews}
            className="text-xs uppercase tracking-wider underline hover:opacity-80"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && reviews.length === 0 && (
        <div className="p-12 text-center text-xs font-mono text-[#8e8e93]">
          <div className="text-2xl mb-2 animate-bounce">⏳</div>
          Loading pending manager reviews…
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && reviews.length === 0 && (
        <div className="p-12 text-center bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl">
          <div className="text-4xl mb-3">✨</div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-1">Queue is Clear</h3>
          <p className="text-xs text-[#8e8e93] max-w-md mx-auto">
            There are currently no AI answers awaiting manager review in your team.
          </p>
          <button
            type="button"
            onClick={fetchReviews}
            className="mt-4 px-4 py-2 text-xs font-bold rounded-lg bg-[#2c2c2e] hover:bg-[#3a3a3c] text-white transition-colors"
          >
            Check Again
          </button>
        </div>
      )}

      {/* Reviews list */}
      <div className="space-y-4">
        {reviews.map((item) => {
          const isSubmitting = submittingIds[item.id] || false;
          const conflictErr = conflictErrors[item.id];
          const isEditing = editingCardId === item.id;
          const optionsList = Array.isArray(item.options) ? item.options : [];
          const isOpDenied = item.operator_action === 'denied';
          const isOpEdited = item.operator_action === 'edited';
          const canDirectApprove = isManagerDirectApproveAllowed(item.operator_action);

          return (
            <div
              key={item.id}
              data-testid={`manager-review-card-${item.id}`}
              className="bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl p-5 shadow-lg relative transition-all"
            >
              {/* Card Meta Top: Candidate, ID, Revision */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-[#2c2c2e]/60 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-white text-sm">
                    {item.candidate_name || 'Candidate'}
                  </span>
                  <span className="font-mono text-[#8e8e93] bg-[#2c2c2e]/60 px-2 py-0.5 rounded text-[11px]">
                    {item.applywizz_id}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-[#8e8e93]">
                  <span>Field: {item.field_key.slice(0, 10)}</span>
                  <span className="px-1.5 py-0.5 rounded bg-[#2c2c2e] text-white font-bold">
                    rev {item.revision}
                  </span>
                </div>
              </div>

              {/* Question Context */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93] bg-[#2c2c2e] px-1.5 py-0.5 rounded">
                    {item.field_type || 'field'}
                  </span>
                </div>
                <h4 className="text-sm font-semibold text-white leading-relaxed">
                  {item.question_label}
                </h4>

                {optionsList.length > 0 && (
                  <div className="mt-2 text-xs">
                    <span className="text-[10px] uppercase font-bold text-[#8e8e93] block mb-1">Options:</span>
                    <div className="flex flex-wrap gap-1">
                      {optionsList.map((opt: string, i: number) => (
                        <span key={i} className="px-2 py-0.5 text-[11px] rounded bg-[#141416] border border-[#2c2c2e] text-[#8e8e93]">
                          {opt}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Two-column layout for AI Context and Operator Action */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                {/* AI Proposed Context */}
                <div className="bg-[#141416] border border-[#2c2c2e] rounded-lg p-3.5">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93]">
                      Original AI Proposal
                    </span>
                    <div className="flex items-center gap-2 text-[10px] font-mono">
                      {item.ai_confidence != null && (
                        <span className="text-[#30d158] font-bold bg-[#30d158]/10 px-1.5 py-0.5 rounded">
                          {Math.round(item.ai_confidence * 100)}% conf
                        </span>
                      )}
                      <span className="text-[#0a84ff] bg-[#0a84ff]/10 px-1.5 py-0.5 rounded">
                        {item.ai_model}
                      </span>
                    </div>
                  </div>
                  <div className="text-xs font-mono text-white whitespace-pre-wrap break-words leading-relaxed">
                    {item.ai_value}
                  </div>
                </div>

                {/* Operator Decision Context */}
                <div className="bg-[#141416] border border-[#2c2c2e] rounded-lg p-3.5">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#8e8e93]">
                      Operator Action
                    </span>
                    {isOpDenied ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30 px-2 py-0.5 rounded">
                        Denied
                      </span>
                    ) : isOpEdited ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/30 px-2 py-0.5 rounded">
                        Edited
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-wider bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30 px-2 py-0.5 rounded">
                        Approved
                      </span>
                    )}
                  </div>

                  {isOpEdited && item.operator_value ? (
                    <div className="text-xs font-mono text-white whitespace-pre-wrap break-words leading-relaxed">
                      <span className="text-[#8e8e93] text-[10px] block uppercase mb-1">Operator Value:</span>
                      {item.operator_value}
                    </div>
                  ) : isOpDenied ? (
                    <div className="text-xs font-sans text-[#ff453a] leading-relaxed">
                      Operator marked AI answer as incorrect. Replacement required to approve.
                    </div>
                  ) : (
                    <div className="text-xs font-sans text-[#30d158] leading-relaxed">
                      Operator verified and approved the AI answer.
                    </div>
                  )}

                  {item.operator_email && (
                    <div className="mt-2 text-[10px] font-mono text-[#8e8e93] flex items-center justify-between">
                      <span>By: {item.operator_email}</span>
                      {item.operator_actioned_at && (
                        <span>{new Date(item.operator_actioned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Stale Revision Error Alert */}
              {conflictErr && (
                <div className="mb-4 bg-[#ff9f0a]/15 border border-[#ff9f0a]/40 rounded-lg p-3 text-xs font-semibold text-[#ff9f0a] flex items-center justify-between">
                  <span>{conflictErr}</span>
                  <button
                    type="button"
                    onClick={fetchReviews}
                    className="underline text-[11px] ml-2 font-bold hover:opacity-80"
                  >
                    Refresh
                  </button>
                </div>
              )}

              {/* Edit Mode View */}
              {isEditing ? (
                <div className="bg-[#141416] border border-[#0a84ff]/40 rounded-lg p-3.5 mb-2">
                  <label className="block text-xs font-bold text-white uppercase tracking-wider mb-2">
                    Manager Replacement Answer
                  </label>
                  <textarea
                    value={editedValue}
                    onChange={(e) => setEditedValue(e.target.value)}
                    placeholder="Enter verified replacement answer…"
                    rows={3}
                    className="w-full bg-[#1c1c1e] border border-[#2c2c2e] rounded-md p-2.5 text-xs text-white placeholder-[#8e8e93] focus:outline-none focus:border-[#0a84ff] font-mono"
                  />
                  {editError && (
                    <p className="mt-1.5 text-xs font-semibold text-[#ff453a]">{editError}</p>
                  )}
                  <div className="flex items-center justify-end gap-2 mt-3">
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      disabled={isSubmitting}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#2c2c2e] hover:bg-[#3a3a3c] text-[#8e8e93] hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSubmitEdit(item)}
                      disabled={isSubmitting}
                      className="px-4 py-1.5 text-xs font-bold rounded-lg bg-[#0a84ff] hover:bg-[#0a84ff]/90 text-white transition-colors disabled:opacity-50"
                    >
                      {isSubmitting ? 'Saving…' : 'Save & Approve'}
                    </button>
                  </div>
                </div>
              ) : (
                /* Normal Action Buttons */
                <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => handleAction(item, 'reject')}
                    disabled={isSubmitting}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/40 hover:bg-[#ff453a]/25 transition-colors disabled:opacity-50"
                  >
                    {isSubmitting ? 'Rejecting…' : 'Reject'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStartEdit(item)}
                    disabled={isSubmitting}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/40 hover:bg-[#0a84ff]/25 transition-colors disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAction(item, 'approve')}
                    disabled={isSubmitting || !canDirectApprove}
                    title={!canDirectApprove ? 'Operator denied this proposal. Click Edit to provide a replacement value.' : 'Approve proposal'}
                    className={`px-4 py-1.5 text-xs font-bold rounded-lg transition-colors ${
                      canDirectApprove
                        ? 'bg-[#30d158] text-black hover:bg-[#30d158]/90 disabled:opacity-50'
                        : 'bg-[#2c2c2e] text-[#8e8e93] cursor-not-allowed opacity-60'
                    }`}
                  >
                    {isSubmitting ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ManagerReviewTab;
