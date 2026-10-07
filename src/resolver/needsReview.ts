/**
 * Resolve-time routing: whether an application needs operator review
 * before submission (auto-queue vs READY_FOR_REVIEW).
 */

export type NeedsReviewField = {
  isRequired?: boolean | null;
  source?: string | null;
};

/**
 * True when any required field was answered by AI or left unresolved.
 * Optional AI/unresolved fields do not block auto-queue.
 */
export function applicationNeedsOperatorReview(fields: NeedsReviewField[]): boolean {
  if (!Array.isArray(fields) || fields.length === 0) return false;
  return fields
    .filter((f) => Boolean(f?.isRequired))
    .some((f) => !f.source || f.source === 'ai' || f.source === 'unresolved');
}
