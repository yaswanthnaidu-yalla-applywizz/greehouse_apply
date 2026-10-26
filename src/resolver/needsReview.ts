/**
 * Resolve-time routing: whether an application needs operator review
 * before submission (auto-queue vs READY_FOR_REVIEW).
 */

export type NeedsReviewField = {
  isRequired?: boolean | null;
  source?: string | null;
  confidence?: number | null;
  label?: string | null;
  value?: string | null;
};

/**
 * True when:
 * 1. Any required field is unresolved.
 * 2. Any required field was resolved using AI (source === 'ai').
 * 3. Any salary / compensation field was resolved negatively ("No", "Decline").
 *
 * Optional AI/unresolved fields do not block auto-queue.
 */
export function applicationNeedsOperatorReview(fields: NeedsReviewField[]): boolean {
  if (!Array.isArray(fields) || fields.length === 0) return false;

  // 0. Mandatory Cover Letter (must not auto-queue since system policy omits cover letters)
  const hasRequiredCoverLetter = fields.some((f) => {
    const combined = `${f.label || ''} ${(f as any).name || ''} ${(f as any).fieldId || ''}`.toLowerCase();
    return Boolean(f.isRequired) && /cover\s*letter|cover_letter/i.test(combined);
  });
  if (hasRequiredCoverLetter) {
    return true;
  }

  return fields.some((f) => {
    // 1. Unresolved required field
    if (f.isRequired && (!f.source || f.source === 'unresolved')) {
      return true;
    }

    // 2. Any required field solved by AI (auto-queue requires 100% resolved without AI)
    if (f.isRequired && f.source === 'ai') {
      return true;
    }

    // 3. Negative answers on salary / compensation questions
    const label = (f.label || '').toLowerCase();
    if (/(salary|compensation|expected pay|pay requirement)/i.test(label)) {
      const val = String(f.value || '').trim().toLowerCase();
      if (val === 'no' || /^no\b/i.test(val) || val.includes('decline')) {
        return true;
      }
    }

    return false;
  });
}

/**
 * Total count of ALL fields (required + optional) resolved via AI (Tier 5).
 */
export function countAiFields(fields: NeedsReviewField[]): number {
  if (!Array.isArray(fields)) return 0;
  return fields.filter((f) => f.source === 'ai').length;
}

/**
 * Total count of REQUIRED fields resolved via AI (Tier 5).
 */
export function countRequiredAiFields(fields: NeedsReviewField[]): number {
  if (!Array.isArray(fields)) return 0;
  return fields.filter((f) => Boolean(f.isRequired) && f.source === 'ai').length;
}

/**
 * Total count of REQUIRED fields that remain unresolved across all tiers.
 */
export function countUnresolvedRequiredFields(fields: NeedsReviewField[]): number {
  if (!Array.isArray(fields)) return 0;
  return fields.filter((f) => Boolean(f.isRequired) && (!f.source || f.source === 'unresolved')).length;
}

/**
 * Filtered-out routing:
 * An application is filtered out when:
 * 1. Required AI field count > 3, OR
 * 2. Unresolved required field count > 3.
 *
 * Optional AI or optional unresolved fields never cause an application to be filtered out.
 */
export function applicationShouldBeFilteredOut(fields: NeedsReviewField[]): boolean {
  if (!Array.isArray(fields) || fields.length === 0) return false;
  return countRequiredAiFields(fields) > 3 || countUnresolvedRequiredFields(fields) > 3;
}


