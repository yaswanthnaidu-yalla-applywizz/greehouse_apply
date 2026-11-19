/**
 * @fileoverview ATS URL Classification and Ashby Job Identifier Extraction.
 */

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function toRipplingApplicationUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'ats.rippling.com') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (/^[a-z]{2}-[a-z]{2}$/i.test(segments[0] || '')) segments.shift();
    if (segments.length < 3 || segments.length > 4 || segments[1] !== 'jobs') return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[2])) return null;
    if (segments.length === 4 && segments[3] !== 'apply') return null;
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${segments.length === 3 ? '/apply' : ''}`;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isRipplingUrl(url: string): boolean {
  return toRipplingApplicationUrl(url) !== null;
}

export function isRipplingHost(url: string): boolean {
  try {
    return new URL(url.trim()).hostname.toLowerCase() === 'ats.rippling.com';
  } catch {
    return false;
  }
}

/**
 * Canonicalizes an Ashby job/application URL to its application route.
 * Preserves query parameters and returns null for custom domains where slug/path cannot be resolved directly.
 */
export function toAshbyApplicationUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (host === 'jobs.ashbyhq.com' || host === 'localhost' || host === '127.0.0.1') {
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      const appPath = cleanPath.endsWith('/application') ? cleanPath : `${cleanPath}/application`;
      return `${parsed.origin}${appPath}${parsed.search}`;
    }
    return null;
  } catch {
    return null;
  }
}

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
    return host.includes('greenhouse.io') || host.includes('grnh.se') || parsed.searchParams.has('gh_jid');
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

/**
 * Checks if a URL targets Lever ATS.
 */
export function isLeverUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
    const host = parsed.hostname.toLowerCase();
    return host === 'jobs.lever.co' || host === 'api.lever.co' || host.endsWith('.lever.co');
  } catch {
    return false;
  }
}

/**
 * Canonicalizes a Lever job URL to its /apply application route.
 */
export function toLeverApplicationUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'jobs.lever.co' && !host.endsWith('.lever.co')) return null;

    const segments = parsed.pathname.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length < 2) return null;

    const company = segments[0];
    const jobId = segments[1];
    return `https://${host}/${company}/${jobId}/apply${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Extracts company slug and jobId from a Lever job URL.
 */
export function extractLeverJobIds(url: string): { company: string; jobId: string } | null {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'jobs.lever.co' && !host.endsWith('.lever.co') && host !== 'api.lever.co') return null;

    const segments = parsed.pathname.split('/').map((s) => s.trim()).filter(Boolean);
    // Path could be /v0/postings/<company>/<jobId> or /<company>/<jobId>
    if (host === 'api.lever.co' && segments[0] === 'v0' && segments[1] === 'postings' && segments.length >= 4) {
      return { company: segments[2], jobId: segments[3] };
    }
    if (segments.length >= 2) {
      return { company: segments[0], jobId: segments[1] };
    }
    return null;
  } catch {
    return null;
  }
}

