export type AtsNavigationStatus = 'ok' | 'expired' | 'throttled' | 'temporary' | 'blocked';

export function classifyAtsNavigationStatus(status: number): AtsNavigationStatus {
  if (status < 400) return 'ok';
  if (status === 404 || status === 410) return 'expired';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'temporary';
  return 'blocked';
}

export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

export type AtsScanFailureKind = Exclude<AtsNavigationStatus, 'ok' | 'expired'> | 'challenge' | 'extraction';

export class AtsScanFailure extends Error {
  constructor(
    readonly kind: AtsScanFailureKind,
    message: string,
    readonly httpStatus: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'AtsScanFailure';
  }
}

export function navigationFailure(status: number, retryAfter: string | null, nowMs = Date.now()): AtsScanFailure {
  const kind = classifyAtsNavigationStatus(status);
  if (kind === 'ok' || kind === 'expired') {
    throw new Error(`HTTP ${status} is not a temporary ATS scan failure`);
  }
  return new AtsScanFailure(
    kind,
    `ATS page returned HTTP ${status}`,
    status,
    kind === 'throttled' ? parseRetryAfter(retryAfter, nowMs) : null,
  );
}

export function extractAtsHostKey(url: string, _ats?: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const segments = parsed.pathname.split('/').filter(Boolean);
    const isMultiTenant = host.includes('ashbyhq.com') || host.includes('lever.co') || host === '127.0.0.1' || host === 'localhost';
    if (isMultiTenant && segments.length > 0) {
      return `${host}${port}/${segments[0].toLowerCase()}`;
    }
    return `${host}${port}`;
  } catch {
    return url;
  }
}
