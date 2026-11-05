/**
 * @fileoverview Domain-aware resume naming utilities for ATS job submissions and storage.
 * Standardizes naming convention: RESUME_<CLIENTNAME>_<DOMAIN>.pdf
 */

const NOISE_WORDS = new Set([
  'senior',
  'junior',
  'lead',
  'staff',
  'principal',
  'associate',
  'entry',
  'intern',
  'remote',
  'hybrid',
  'onsite',
  'us',
  'contract',
  'fulltime',
  'full-time',
  'parttime',
  'part-time',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
]);

/**
 * Normalizes and sanitizes a client name for resume filenames.
 * Example: "John Doe" -> "JOHN_DOE"
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
 * Extracts a standardized domain category from job context or candidate role.
 */
function matchCategory(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // 1. High-specificity tracks first
  if (/full[\s-]*stack/i.test(lower)) return 'FULL_STACK';
  if (/devops|cloud|infrastructure|\bsre\b|site\s*reliability/i.test(lower)) return 'DEVOPS';
  if (/data\s*engineer|data\s*pipeline|\betl\b/i.test(lower)) return 'DATA_ENGINEER';
  if (/data\s*scientist/i.test(lower)) return 'DATA_SCIENCE';
  if (/data\s*analyst|analytics|\bbi\b\s*analyst/i.test(lower)) return 'DATA_ANALYST';
  if (/machine\s*learning|deep\s*learning|\bml\b|\bai\b|artificial\s*intelligence|gen[\s-]*ai|\bllm\b/i.test(lower)) return 'AI_ML';
  if (/qa\b|\btest\b|quality\s*assurance|\bsdet\b/i.test(lower)) return 'QA_TEST';
  if (/security|infosec|cyber/i.test(lower)) return 'SECURITY';
  if (/product\s*manager|\bpm\b/i.test(lower)) return 'PRODUCT_MANAGER';
  if (/business\s*analyst|\bba\b/i.test(lower)) return 'BUSINESS_ANALYST';
  if (/designer|\bux\b|\bui\/ux\b/i.test(lower)) return 'DESIGNER';
  if (/mobile|\bios\b|\bandroid\b|\bflutter\b|react[\s-]*native/i.test(lower)) return 'MOBILE';
  if (/front[\s-]*end|\bui\b|\breact\b|\bvue\b|\bangular\b/i.test(lower)) return 'FRONTEND';
  if (/back[\s-]*end|\bnode(?:\.js)?\b|\bgolang\b|\bjava\b|\bpython\b|\bapi\b/i.test(lower)) return 'BACKEND';
  if (/software\s*(?:engineer|developer)|\bswe\b|programmer/i.test(lower)) return 'SOFTWARE_ENGINEER';

  return null;
}

/**
 * Cleans arbitrary job title into a clean domain slug if no standard category matched.
 */
function cleanCustomTitleToDomain(title: string): string | null {
  if (!title) return null;

  // Split title before separators like -, |, ,, (, etc.
  const primaryPart = title.split(/[-–—|,/(]/)[0].trim();
  const words = primaryPart
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return null;

  // Take up to 3 meaningful words
  return words.slice(0, 3).join('_').toUpperCase();
}

/**
 * Resolves the uppercase domain slug for resume naming based on job title,
 * company name, or fallback candidate profile role.
 */
export function resolveResumeDomain(
  jobTitle?: string | null,
  companyName?: string | null,
  fallbackRole?: string | null
): string {
  const jobContext = [companyName, jobTitle].filter(Boolean).join(' ').trim();

  // Try matching category against job context
  const directMatch = matchCategory(jobContext);
  if (directMatch) return directMatch;

  // Try custom slug from job title
  if (jobTitle) {
    const customSlug = cleanCustomTitleToDomain(jobTitle);
    if (customSlug) return customSlug;
  }

  // Fallback to candidate profile role
  if (fallbackRole) {
    const fallbackMatch = matchCategory(fallbackRole);
    if (fallbackMatch) return fallbackMatch;

    const fallbackSlug = cleanCustomTitleToDomain(fallbackRole);
    if (fallbackSlug) return fallbackSlug;
  }

  return 'GENERAL';
}

/**
 * Builds standard resume submission filename: RESUME_<CLIENTNAME>_<DOMAIN>.pdf
 */
export function buildResumeSubmissionFilename(
  clientName?: string | null,
  jobTitle?: string | null,
  companyName?: string | null,
  fallbackRole?: string | null
): string {
  const sanitizedClient = sanitizeResumeClientName(clientName);
  const domain = resolveResumeDomain(jobTitle, companyName, fallbackRole);
  return `RESUME_${sanitizedClient}_${domain}.pdf`;
}
