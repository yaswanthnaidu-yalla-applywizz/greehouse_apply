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

/** SKIPPED applications must not appear in the operator application queue. */
export function excludeSkippedApplicationJobs<T extends { status?: string | null }>(jobs: T[]): T[] {
  return jobs.filter((job) => (job.status || '').toUpperCase() !== 'SKIPPED');
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
