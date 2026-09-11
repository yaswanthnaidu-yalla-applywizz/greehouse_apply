/**
 * @fileoverview Maps Supabase Realtime `candidate_applications` rows into dashboard application state.
 */

export type RealtimeApplicationRow = Record<string, unknown>;

function urlsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const na = decodeURIComponent(a);
    const nb = decodeURIComponent(b);
    return na === nb || na.includes(nb) || nb.includes(na);
  } catch {
    return a.includes(b) || b.includes(a);
  }
}

export function applicationRowMatchesView(
  row: RealtimeApplicationRow,
  view: { id?: string | null; jobUrl?: string | null; job_url?: string | null }
): boolean {
  const rowId = typeof row.id === 'string' ? row.id : '';
  const viewId = view.id || '';
  if (rowId && viewId && rowId === viewId) return true;

  const rowJob = typeof row.job_url === 'string' ? row.job_url : '';
  const viewJob = view.jobUrl || view.job_url || '';
  return urlsMatch(rowJob, viewJob);
}

export function mergeApplicationFromRealtimeRow<T extends Record<string, unknown>>(
  prev: T | null,
  row: RealtimeApplicationRow
): T | null {
  if (!prev) return prev;
  if (!applicationRowMatchesView(row, prev as { id?: string; jobUrl?: string; job_url?: string })) {
    return prev;
  }

  const status = row.status as string | undefined;
  const errorMessage = (row.error_message as string | null | undefined) ?? undefined;

  return {
    ...prev,
    id: (row.id as string) || (prev.id as string),
    status: status ?? (prev.status as string),
    error_message: errorMessage ?? (prev.error_message as string | undefined),
    errorMessage: errorMessage ?? (prev.errorMessage as string | undefined),
    proof_web_url: row.proof_web_url ?? prev.proof_web_url,
    proofWebUrl: row.proof_web_url ?? prev.proofWebUrl,
    proof_captured_at: row.proof_captured_at ?? prev.proof_captured_at,
    proofCapturedAt: row.proof_captured_at ?? prev.proofCapturedAt,
    proof_failed_url: row.proof_failed_url ?? prev.proof_failed_url,
    proofFailedUrl: row.proof_failed_url ?? prev.proofFailedUrl,
    proof_failed_captured_at: row.proof_failed_captured_at ?? prev.proof_failed_captured_at,
    proofFailedCapturedAt: row.proof_failed_captured_at ?? prev.proofFailedCapturedAt,
    proof_email_url: row.proof_email_url ?? prev.proof_email_url,
    proofEmailUrl: row.proof_email_url ?? prev.proofEmailUrl,
    proof_email_json: row.proof_email_json ?? prev.proof_email_json,
    proofEmailJson: row.proof_email_json ?? prev.proofEmailJson,
    proof_email_captured_at: row.proof_email_captured_at ?? prev.proof_email_captured_at,
    email_proof_status: row.email_proof_status ?? prev.email_proof_status,
    emailProofStatus: row.email_proof_status ?? prev.emailProofStatus,
    dry_run_screenshot_url: row.dry_run_screenshot_url ?? prev.dry_run_screenshot_url,
    dryRunScreenshotUrl: row.dry_run_screenshot_url ?? prev.dryRunScreenshotUrl,
    submitted_at: row.submitted_at ?? prev.submitted_at,
    submittedAt: row.submitted_at ?? prev.submittedAt,
    updated_at: row.updated_at ?? prev.updated_at,
  } as T;
}

export function patchJobInCandidateDetail<
  T extends { jobs: Array<{ canonicalUrl?: string; rawUrl?: string; status?: string; error_message?: string }> }
>(detail: T, row: RealtimeApplicationRow): T {
  const rowJob = typeof row.job_url === 'string' ? row.job_url : '';
  const status = typeof row.status === 'string' ? row.status : undefined;
  const error_message =
    typeof row.error_message === 'string' ? row.error_message : (row.error_message as null) ?? undefined;

  return {
    ...detail,
    jobs: detail.jobs.map((job) => {
      const jobUrl = job.canonicalUrl || job.rawUrl || '';
      if (!urlsMatch(jobUrl, rowJob)) return job;
      return {
        ...job,
        status: status ?? job.status,
        error_message: error_message ?? job.error_message,
      };
    }),
  };
}
