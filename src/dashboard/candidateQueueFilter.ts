/**
 * Ensures the operator job queue only contains applications for one applywizz_id.
 */

export function normalizeApplywizzId(id: string | null | undefined): string {
  return (id || '').trim().toUpperCase();
}

export function isSameApplywizzId(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeApplywizzId(a);
  const nb = normalizeApplywizzId(b);
  return Boolean(na && nb && na === nb);
}

type JobWithOptionalOwner = {
  applywizz_id?: string;
  applywizzId?: string;
};

/**
 * Drops queue items tagged with a different candidate's applywizz_id (if present on the row).
 */
export function filterJobsForCandidate<T extends JobWithOptionalOwner>(
  jobs: T[],
  applywizzId: string
): T[] {
  const expected = normalizeApplywizzId(applywizzId);
  if (!expected) return [];
  return jobs.filter((job) => {
    const owner = normalizeApplywizzId(job.applywizzId || job.applywizz_id);
    return !owner || owner === expected;
  });
}

export function candidateDetailMatchesSelection(
  detail: { applywizzId?: string; applywizz_id?: string } | null | undefined,
  selectedApplywizzId: string | null | undefined
): boolean {
  if (!detail || !selectedApplywizzId) return false;
  const detailId = detail.applywizzId || detail.applywizz_id;
  return isSameApplywizzId(detailId, selectedApplywizzId);
}
