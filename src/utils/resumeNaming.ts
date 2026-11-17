/**
 * @fileoverview Dynamic, professional resume/cover letter filename utilities for ATS submissions and storage.
 *
 * Format: Resume_FirstName_LastName_JobRole.pdf
 * Falls back gracefully if any component is missing:
 *   - Resume_John_Smith_Software_Engineer.pdf
 *   - Resume_John_Smith.pdf (when role is missing)
 *   - Resume_Candidate.pdf (when name is missing)
 */

/**
 * Extracts the job title/role from a page title string or current document.title.
 * Strips ATS suffixes and common prefixes like "Job Application for".
 */
export function extractJobRoleFromPage(pageTitle?: string | null): string {
  try {
    let title = (pageTitle ?? (typeof document !== 'undefined' ? document.title : '')) || '';
    if (!title || typeof title !== 'string') return '';

    // Remove common ATS suffixes like "| Greenhouse", "| Workday", "| Lever", etc.
    title = title
      .replace(/\|\s*(Greenhouse|Workday|Lever|Ashby|iCIMS|SmartRecruiters|BambooHR|Taleo|SuccessFactors)\s*$/i, '')
      .trim();

    // Format: "Job Title at Company"
    if (title.includes(' at ')) {
      return cleanJobRole(title.split(' at ')[0].trim());
    }

    // Format: "Job Title - Company - Platform" or "Job Title - Company"
    if (title.includes(' - ')) {
      const parts = title.split(' - ');
      return cleanJobRole(parts[0].trim());
    }

    // Format: "Platform | Job Title | Company" or just "Job Title | Company"
    if (title.includes(' | ')) {
      const parts = title.split(' | ').map((p) => p.trim()).filter(Boolean);
      const candidate = parts.find((p) => p.split(' ').length >= 2) || '';
      return cleanJobRole(candidate);
    }

    return cleanJobRole(title);
  } catch {
    return '';
  }
}

/**
 * Strips common ATS boilerplate prefixes from an extracted candidate string.
 */
export function cleanJobRole(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/^(job\s+application\s+for|application\s+for|apply\s+for|apply\s+to|applying\s+for)\s+/i, '')
    .trim();
}

/**
 * Sanitizes a string for use in a file name:
 * - Removes invalid filename characters
 * - Replaces spaces/special chars with underscores
 * - Collapses multiple underscores
 * - Trims leading/trailing underscores
 * - Limits length
 */
export function sanitizeForFileName(text: string, maxLength = 30): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/[\s\-–—,;.()[\]{}!@#$%^&+=~`']+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, maxLength);
}

export interface CandidateProfileInput {
  personal?: { firstName?: string; lastName?: string };
  firstName?: string | null;
  lastName?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  client_name?: string | null;
  jobTitle?: string | null;
  job_title?: string | null;
  experience?: Array<{ title?: string | null }>;
  workExperience?: Array<{ title?: string | null }>;
  work_experience?: Array<{ title?: string | null }>;
}

/**
 * Builds a professional, dynamic resume or cover letter filename.
 * Format: Resume_FirstName_LastName_JobRole.pdf
 */
export function buildDocumentFileName(
  profileOrName?: CandidateProfileInput | string | null,
  jobTitleOrPage?: string | null,
  storedFileName?: string | null,
  isResume = true
): string {
  const prefix = isResume ? 'Resume' : 'CoverLetter';

  const ext = storedFileName?.endsWith('.docx')
    ? '.docx'
    : storedFileName?.endsWith('.doc')
    ? '.doc'
    : '.pdf';

  let firstName = '';
  let lastName = '';
  let fallbackRole = '';

  if (typeof profileOrName === 'string') {
    const rawName = profileOrName.trim();
    if (rawName) {
      const nameParts = rawName.split(/\s+/);
      firstName = nameParts[0] || '';
      lastName = nameParts.slice(1).join(' ') || '';
    }
  } else if (profileOrName && typeof profileOrName === 'object') {
    firstName = (
      profileOrName.personal?.firstName ||
      profileOrName.firstName ||
      profileOrName.first_name ||
      ''
    ).trim();

    lastName = (
      profileOrName.personal?.lastName ||
      profileOrName.lastName ||
      profileOrName.last_name ||
      ''
    ).trim();

    if (!firstName && !lastName && profileOrName.client_name) {
      const parts = profileOrName.client_name.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    fallbackRole = (
      profileOrName.jobTitle ||
      profileOrName.job_title ||
      profileOrName.experience?.[0]?.title ||
      profileOrName.workExperience?.[0]?.title ||
      profileOrName.work_experience?.[0]?.title ||
      ''
    ).trim();
  }

  // 1. Extract role from job title / page title, then fallback to profile's role
  let jobRole = extractJobRoleFromPage(jobTitleOrPage);
  if (!jobRole && fallbackRole) {
    jobRole = cleanJobRole(fallbackRole);
  }

  const parts: string[] = [prefix];
  if (firstName) parts.push(sanitizeForFileName(firstName, 20));
  if (lastName) parts.push(sanitizeForFileName(lastName, 20));
  if (jobRole) parts.push(sanitizeForFileName(jobRole, 30));

  if (parts.length === 1) {
    parts.push('Candidate');
  }

  return parts.join('_') + ext;
}

/**
 * Backwards-compatible resume submission filename builder.
 * Drops directly into formFiller, ashbySubmit, and storage callers.
 */
export function buildResumeSubmissionFilename(
  clientNameOrProfile?: CandidateProfileInput | string | null,
  jobTitle?: string | null,
  _companyName?: string | null,
  fallbackRole?: string | null,
  storedFileName?: string | null
): string {
  const roleInput = jobTitle || fallbackRole || '';
  return buildDocumentFileName(clientNameOrProfile, roleInput, storedFileName, true);
}

/**
 * Builds standard storage filename for master resumes in Supabase Storage.
 * Format: Resume_FirstName_LastName.pdf (falls back to Resume_AWL_ID.pdf)
 */
export function buildResumeStorageFilename(
  profileOrName?: CandidateProfileInput | string | null,
  applywizzId?: string,
  storedFileName?: string | null
): string {
  const ext = storedFileName?.endsWith('.docx')
    ? '.docx'
    : storedFileName?.endsWith('.doc')
    ? '.doc'
    : '.pdf';

  let firstName = '';
  let lastName = '';

  if (typeof profileOrName === 'string') {
    const rawName = profileOrName.trim();
    if (rawName) {
      const nameParts = rawName.split(/\s+/);
      firstName = nameParts[0] || '';
      lastName = nameParts.slice(1).join(' ') || '';
    }
  } else if (profileOrName && typeof profileOrName === 'object') {
    firstName = (
      profileOrName.personal?.firstName ||
      profileOrName.firstName ||
      profileOrName.first_name ||
      ''
    ).trim();

    lastName = (
      profileOrName.personal?.lastName ||
      profileOrName.lastName ||
      profileOrName.last_name ||
      ''
    ).trim();

    if (!firstName && !lastName && profileOrName.client_name) {
      const parts = profileOrName.client_name.trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }
  }

  const parts: string[] = ['Resume'];
  if (firstName) parts.push(sanitizeForFileName(firstName, 20));
  if (lastName) parts.push(sanitizeForFileName(lastName, 20));

  if (parts.length === 1) {
    if (applywizzId) {
      parts.push(sanitizeForFileName(applywizzId, 25));
    } else {
      parts.push('Candidate');
    }
  }

  return parts.join('_') + ext;
}

/**
 * Legacy helper maintained for any remaining external references.
 */
export function sanitizeResumeClientName(name?: string | null, fallback: string = 'CANDIDATE'): string {
  const sanitized = (name || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s_]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return sanitized || fallback;
}

/**
 * Legacy domain shortcode resolver.
 */
export function resolveResumeDomain(
  jobTitle?: string | null,
  companyName?: string | null,
  fallbackRole?: string | null
): string {
  const title = jobTitle || fallbackRole || companyName || '';
  const clean = cleanJobRole(title);
  return sanitizeForFileName(clean, 30).toUpperCase() || 'GENERAL';
}
