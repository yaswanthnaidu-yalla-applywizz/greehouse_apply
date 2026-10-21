/**
 * @fileoverview Shared utilities and helpers for inbox polling and OTP extraction.
 */

export const OTP_EMAIL_CLOCK_SKEW_MS = 5_000;

export function parseZohoReceivedTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isMessageEligibleByTimestamp(
  receivedTimeMs: number,
  sinceTimestamp: number,
  clockSkewMs: number = OTP_EMAIL_CLOCK_SKEW_MS
): boolean {
  if (!sinceTimestamp || !Number.isFinite(sinceTimestamp) || sinceTimestamp <= 0) {
    return true;
  }
  const minTimeMs = sinceTimestamp - clockSkewMs;
  return receivedTimeMs >= minTimeMs;
}

export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCompanyName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|technologies|tech|solutions|co)\b[.]?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function getErrorCategory(error: unknown): string {
  const typed =
    error && typeof error === 'object'
      ? (error as { name?: unknown; code?: unknown; cause?: { code?: unknown } })
      : {};
  const name =
    typeof typed.name === 'string' ? typed.name.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : 'UnknownError';
  const codeValue = typed.code ?? typed.cause?.code;
  const code =
    typeof codeValue === 'string' ? codeValue.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return code ? `${name}_${code}` : name;
}

/**
 * Extracts an alphanumeric or numeric OTP code from email text or subject.
 */
export function extractOtpCodeFromText(text: string): string | null {
  if (!text) return null;

  // Pattern 0: Greenhouse's exact wording:
  // "Copy and paste this code into the security code field on your application: NgW4NT62"
  const greenhousePattern =
    /copy\s*and\s*paste\s*this\s*code[\s\S]{0,140}?(?::|\bis\b)[\s\r\n]*([A-Za-z0-9]{6,16})\b/i;
  const match0 = text.match(greenhousePattern);
  if (match0 && match0[1]) {
    return match0[1].trim();
  }

  // Pattern 1: Explicit labeled OTP code
  const explicitPattern =
    /(?:security\s*code|verification\s*code|verify\s*your\s*account\s*with|one-time\s*(?:passcode|code|password)|your\s*(?:verification\s*)?code|enter\s*(?:the\s*)?(?:following\s*)?code|confirmation\s*code|temporary\s*code)[^:\n]{0,80}(?:\s+is|\s*:)[\s\r\n:=]*([A-Za-z0-9]{6,16})\b/i;
  const match1 = text.match(explicitPattern);
  if (match1 && match1[1]) {
    return match1[1].trim();
  }

  // Pattern 2: 8-character alphanumeric code standalone (e.g. Aebf0aDc)
  const standalonePattern = /\b([A-Za-z0-9]{8})\b/g;
  const words = text.match(standalonePattern) || [];
  const stopWords = new Set([
    'security',
    'complete',
    'received',
    'position',
    'employer',
    'location',
    'continue',
    'question',
    'response',
    'required',
    'password',
    'username',
    'greenhou',
    'candidate',
    'settings',
  ]);
  for (const w of words) {
    if (!stopWords.has(w.toLowerCase())) {
      if (/[0-9]/.test(w) && /[A-Za-z]/.test(w)) {
        return w;
      }
    }
  }

  // Pattern 3: 6-digit numeric code
  const sixDigitPattern = /\b(\d{6})\b/;
  const match3 = text.match(sixDigitPattern);
  if (match3 && match3[1]) {
    return match3[1].trim();
  }

  return null;
}
