/**
 * @fileoverview ATS URL Classification and Ashby Job Identifier Extraction.
 */

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Checks if a URL targets Ashby ATS.
 */
export function isAshbyUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.hostname.toLowerCase().includes('ashby') || parsed.searchParams.has('ashby_jid');
  } catch {
    return false;
  }
}

/**
 * Checks if a URL targets Greenhouse ATS.
 */
export function isGreenhouseUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    return host.includes('greenhouse.io') || host.includes('grnh.se');
  } catch {
    return false;
  }
}

/**
 * Extracts the jobPostingId and organizationHostedJobsPageName slug from standard Ashby URLs.
 * Returns null for custom-domain URLs where slug is not part of the path.
 */
export function extractAshbyJobIds(url: string): { jobPostingId: string; orgSlug: string } | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (!parsed.hostname.toLowerCase().includes('jobs.ashbyhq.com')) {
      return null;
    }

    // Path pattern: /<orgSlug>/<jobPostingId>(/application)?
    const segments = parsed.pathname.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length < 2) return null;

    const orgSlug = segments[0];
    const uuidCandidate = segments[1];

    if (!UUID_REGEX.test(uuidCandidate)) {
      return null;
    }

    const match = uuidCandidate.match(UUID_REGEX);
    return {
      orgSlug,
      jobPostingId: match ? match[0] : uuidCandidate,
    };
  } catch {
    return null;
  }
}

/**
 * Normalizes company identity corresponding to SQL ashby_company_identity (Migration 042).
 * Strips non-alphanumeric chars and lowercases if company name is present and not 'company';
 * otherwise extracts the company slug from jobs.ashbyhq.com URLs, or the domain.
 */
export function ashbyCompanyIdentity(companyName?: string | null, jobUrl?: string | null): string {
  const trimmedName = (companyName || '').trim();
  if (trimmedName && trimmedName.toLowerCase() !== 'company') {
    return trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  const rawUrl = (jobUrl || '').trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      const host = parsed.hostname.toLowerCase();
      if (host === 'jobs.ashbyhq.com') {
        const segments = parsed.pathname.split('/').map((s) => s.trim()).filter(Boolean);
        if (segments.length > 0) {
          return segments[0].toLowerCase();
        }
      }
      return host;
    } catch {
      const parts = rawUrl.split('/');
      if (parts.length > 2 && parts[2].toLowerCase() === 'jobs.ashbyhq.com' && parts[3]) {
        return parts[3].toLowerCase();
      }
      return parts[2] ? parts[2].toLowerCase() : '';
    }
  }

  return '';
}

