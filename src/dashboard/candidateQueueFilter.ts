/**
 * Ensures the operator job queue only contains applications for one applywizz_id.
 */

import { normalizeOperatorErrorMessage } from '../operator/operatorErrorMessages.js';

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

/** Legacy helper — prefer showing all queue rows and badge SKIPPED/unresolved in the UI. */
export function excludeSkippedApplicationJobs<T extends { status?: string | null }>(jobs: T[]): T[] {
  return jobs.filter((job) => (job.status || '').toUpperCase() !== 'SKIPPED');
}

type ResolutionFieldsCarrier = {
  resolved_fields?: unknown;
  resolvedFields?: unknown;
  fieldsCount?: number | null;
};

/** True when the pipeline has persisted a resolution snapshot (non-empty resolved_fields). */
export function applicationRowHasPersistedResolution(row: ResolutionFieldsCarrier): boolean {
  const fields = row.resolved_fields ?? row.resolvedFields;
  if (Array.isArray(fields) && fields.length > 0) return true;
  return typeof row.fieldsCount === 'number' && row.fieldsCount > 0;
}

/** Drops segregator placeholders and other rows the resolver has not populated yet. */
export function excludeUnresolvedApplicationJobs<T extends ResolutionFieldsCarrier & { status?: string | null }>(
  jobs: T[]
): T[] {
  return jobs.filter(
    (job) => applicationRowHasPersistedResolution(job) || (typeof job.fieldsCount === 'number' && job.fieldsCount > 0)
  );
}

/** Operator application queue — all assigned rows (including SKIPPED and pre-resolve placeholders). */
export function filterOperatorApplicationJobs<T extends ResolutionFieldsCarrier & { status?: string | null }>(
  jobs: T[]
): T[] {
  return Array.isArray(jobs) ? jobs : [];
}

export function isSkippedApplicationJob(row: { status?: string | null }): boolean {
  return (row.status || '').trim().toUpperCase() === 'SKIPPED';
}

type ResolvedFieldLike = {
  source?: string | null;
  resolvedByTier?: number | null;
};

/** True when the app has no resolution snapshot or still has tier-missing / unresolved fields. */
/** Statuses that show the full operator form + submit controls. */
export const OPERATOR_SUBMITTABLE_APPLICATION_STATUSES = new Set([
  'READY_FOR_REVIEW',
  'APPROVED',
  'QUEUED',
  'APPLYING',
  'APPLIED',
]);

export function isOperatorFormPanelBlocked(status?: string | null): boolean {
  const normalized = (status || 'READY_FOR_REVIEW').trim().toUpperCase();
  return !OPERATOR_SUBMITTABLE_APPLICATION_STATUSES.has(normalized);
}

export function operatorFormBlockedDetailMessage(app?: {
  error_message?: string | null;
  errorMessage?: string | null;
  error?: string | null;
  status?: string | null;
} | null): string {
  const msg = app?.error_message || app?.errorMessage || app?.error || null;
  return normalizeOperatorErrorMessage(msg, app?.status);
}

export function isUnresolvedApplicationJob(
  row: ResolutionFieldsCarrier & { status?: string | null }
): boolean {
  if (isSkippedApplicationJob(row)) return false;
  if (!applicationRowHasPersistedResolution(row)) return true;
  const fields = (row.resolved_fields ?? row.resolvedFields) as ResolvedFieldLike[] | undefined;
  if (!Array.isArray(fields) || fields.length === 0) {
    return false;
  }
  return fields.some(
    (f) => f && (f.source === 'unresolved' || f.resolvedByTier === null || f.resolvedByTier === undefined)
  );
}

export function candidateDetailMatchesSelection(
  detail: { applywizzId?: string; applywizz_id?: string } | null | undefined,
  selectedApplywizzId: string | null | undefined
): boolean {
  if (!detail || !selectedApplywizzId) return false;
  const detailId = detail.applywizzId || detail.applywizz_id;
  return isSameApplywizzId(detailId, selectedApplywizzId);
}

type JobCardTemplateFields = {
  companyName?: string | null;
  company_name?: string | null;
  jobTitle?: string | null;
  job_title?: string | null;
  scannedCompanyName?: string | null;
  scanned_company_name?: string | null;
  scannedJobTitle?: string | null;
  scanned_job_title?: string | null;
  templateCompanyName?: string | null;
  template_company_name?: string | null;
  templateJobTitle?: string | null;
  template_job_title?: string | null;
};

/** Prefer scanned_job_templates fields enriched on the job row (see dashboard index.html). */
export function jobCardCompanyLabel(job: JobCardTemplateFields): string {
  const fromTemplate =
    job.scannedCompanyName ||
    job.scanned_company_name ||
    job.templateCompanyName ||
    job.template_company_name;
  if (fromTemplate) return fromTemplate;
  return job.companyName || job.company_name || 'Company';
}

export function jobCardTitleLabel(job: JobCardTemplateFields): string {
  const fromTemplate =
    job.scannedJobTitle ||
    job.scanned_job_title ||
    job.templateJobTitle ||
    job.template_job_title;
  if (fromTemplate) return fromTemplate;
  return job.jobTitle || job.job_title || 'Job Application';
}
