/**
 * @fileoverview Client for ApplyWizz CA Management Work History API.
 * Queries assigned candidates for a given CA on a specific date (Asia/Kolkata timezone).
 */

import { config } from '../config/env.js';
import { WORK_HISTORY_API_BASE_URL } from '../server/workHistoryAuth.js';

export const DEFAULT_WORK_HISTORY_API_URL = WORK_HISTORY_API_BASE_URL;

export interface WorkHistoryCandidateRecord {
  applywizzId: string;
  clientName: string;
  clientEmail: string;
}

export interface WorkHistoryResult {
  records: WorkHistoryCandidateRecord[];
  candidateIds: string[];
  unreachable: boolean;
  resolvedDate: string | null;
}

/** Cache key for org-wide admin work-history (no CA email filter). */
export const ADMIN_WORK_HISTORY_CACHE_KEY = '__admin__';

function getWorkHistoryBaseUrl(): string {
  let raw = (config.WORK_HISTORY_API_URL || DEFAULT_WORK_HISTORY_API_URL).trim().replace(/\/$/, '');
  if (/^https:\/\/applywizz-ca-management\.vercel$/i.test(raw)) {
    raw = 'https://applywizz-ca-management.vercel.app';
  }
  if (!/\/api\/ca\/work-history$/i.test(raw)) {
    raw = raw.endsWith('/api/ca') ? `${raw}/work-history` : `${raw}/api/ca/work-history`;
  }
  return raw;
}

/**
 * Builds CA-scoped work-history URL: from=date, to=date, ca_email=signed-in email.
 */
export function buildCaWorkHistoryUrl(caEmail: string, dateStr: string): string {
  const email = caEmail.trim().toLowerCase();
  const base = getWorkHistoryBaseUrl();
  return `${base}?from=${dateStr}&to=${dateStr}&ca_email=${email}`;
}

/**
 * Generates YYYY-MM-DD string for IST (Asia/Kolkata, UTC+5:30) offset by `daysAgo`.
 */
export function getISTDateString(daysAgo: number = 0): string {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  istDate.setUTCDate(istDate.getUTCDate() - daysAgo);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Returns yesterday's calendar date in Asia/Kolkata (IST, UTC+5:30), not UTC. */
export function getYesterdayIST(): string {
  const date = getISTDateString(1);
  console.log(`[WorkHistory] Computed yesterday in IST (UTC+5:30): ${date}`);
  return date;
}

const WORK_HISTORY_FETCH_TIMEOUT_MS = 8000;
const WORK_HISTORY_ADMIN_FETCH_TIMEOUT_MS = 15000;
const WORK_HISTORY_MAX_ATTEMPTS = 3;
const WORK_HISTORY_RETRY_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFetchTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return true;
  const msg = (e.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('aborted');
}

type FetchWorkHistoryOutcome =
  | { ok: true; response: Response }
  | { ok: false; reason: string };

async function fetchWorkHistoryWithRetry(
  fullUrl: string,
  timeoutMs: number
): Promise<FetchWorkHistoryOutcome> {
  let lastReason = 'unknown error';

  for (let attempt = 1; attempt <= WORK_HISTORY_MAX_ATTEMPTS; attempt++) {
    console.log(`[WorkHistory] Fetching ${fullUrl}`);
    try {
      const response = await fetch(fullUrl, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true, response };
    } catch (err: unknown) {
      lastReason = err instanceof Error ? err.message : String(err);
      const timedOut = isFetchTimeoutError(err);
      if (timedOut && attempt < WORK_HISTORY_MAX_ATTEMPTS) {
        console.warn(
          `[WorkHistory] Failed ${fullUrl}: ${lastReason} (timeout, retry ${attempt + 1}/${WORK_HISTORY_MAX_ATTEMPTS} in ${WORK_HISTORY_RETRY_BACKOFF_MS}ms)`
        );
        await sleep(WORK_HISTORY_RETRY_BACKOFF_MS);
        continue;
      }
      console.warn(`[WorkHistory] Failed ${fullUrl}: ${lastReason}`);
      return { ok: false, reason: lastReason };
    }
  }

  console.warn(`[WorkHistory] Failed ${fullUrl}: ${lastReason}`);
  return { ok: false, reason: lastReason };
}

function parseWorkHistoryRecords(data: any): WorkHistoryCandidateRecord[] | null {
  if (!data || !Array.isArray(data.records)) {
    return null;
  }

  const uniqueMap = new Map<string, WorkHistoryCandidateRecord>();
  for (const r of data.records) {
    const rawId = (r.applywizz_id || '').trim().toUpperCase();
    if (rawId && !uniqueMap.has(rawId)) {
      uniqueMap.set(rawId, {
        applywizzId: rawId,
        clientName: (r.client_name || rawId).trim(),
        clientEmail: (r.client_email || '').trim().toLowerCase(),
      });
    }
  }
  return Array.from(uniqueMap.values());
}

/**
 * Queries work-history API for a specific date (IST) and signed-in CA email.
 * Returns null if network error, HTTP error, or timeout occurs.
 */
async function fetchRecordsForDate(
  caEmail: string,
  dateStr: string
): Promise<WorkHistoryCandidateRecord[] | null> {
  const normalizedEmail = caEmail.trim().toLowerCase();
  if (!normalizedEmail) {
    console.warn('[WorkHistory] Failed: missing ca_email (authenticated user email required)');
    return null;
  }

  const fullUrl = buildCaWorkHistoryUrl(normalizedEmail, dateStr);
  const outcome = await fetchWorkHistoryWithRetry(fullUrl, WORK_HISTORY_FETCH_TIMEOUT_MS);
  if (!outcome.ok) {
    return null;
  }

  const res = outcome.response;
  if (!res.ok) {
    const reason = `HTTP ${res.status}`;
    console.warn(`[WorkHistory] Failed ${fullUrl}: ${reason}`);
    return null;
  }

  try {
    const data: any = await res.json();
    const records = parseWorkHistoryRecords(data);
    if (records === null) {
      console.warn(`[WorkHistory] Failed ${fullUrl}: invalid response body (expected records array)`);
      return null;
    }
    console.log(
      `[WorkHistory] Success date=${dateStr} ca_email=${normalizedEmail} records=${records.length}`
    );
    return records;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[WorkHistory] Failed ${fullUrl}: ${message}`);
    return null;
  }
}

/**
 * Fetches assigned candidates for a CA on a specific IST calendar date (YYYY-MM-DD).
 * No multi-day lookback is performed.
 */
export async function fetchWorkHistoryForDate(
  caEmail: string,
  dateStr: string
): Promise<WorkHistoryResult> {
  const records = await fetchRecordsForDate(caEmail, dateStr);
  if (records === null) {
    return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
  }
  return {
    records,
    candidateIds: records.map((r) => r.applywizzId),
    unreachable: false,
    resolvedDate: dateStr,
  };
}

/**
 * Primary CA work-history fetch: yesterday IST for both from and to.
 */
export async function fetchWorkHistoryForAuthenticatedCa(
  caEmail: string,
  dateStr?: string
): Promise<WorkHistoryResult> {
  const targetDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : getYesterdayIST();
  return fetchWorkHistoryForDate(caEmail, targetDate);
}

/**
 * Fetches all assigned candidates for a date (admin view — no ca_email filter).
 */
export async function fetchAdminWorkHistoryForDate(dateStr: string): Promise<WorkHistoryResult> {
  const base = getWorkHistoryBaseUrl();
  const fullUrl = `${base}?from=${dateStr}&to=${dateStr}`;

  const outcome = await fetchWorkHistoryWithRetry(fullUrl, WORK_HISTORY_ADMIN_FETCH_TIMEOUT_MS);
  if (!outcome.ok) {
    return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
  }

  const res = outcome.response;
  if (!res.ok) {
    console.warn(`[WorkHistory] Failed ${fullUrl}: HTTP ${res.status}`);
    return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
  }

  try {
    const data: any = await res.json();
    const records = parseWorkHistoryRecords(data);
    if (records === null) {
      console.warn(`[WorkHistory] Failed ${fullUrl}: invalid response body (expected records array)`);
      return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
    }
    console.log(`[WorkHistory] Success date=${dateStr} ca_email=(admin) records=${records.length}`);
    return {
      records,
      candidateIds: records.map((r) => r.applywizzId),
      unreachable: false,
      resolvedDate: dateStr,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[WorkHistory] Failed ${fullUrl}: ${message}`);
    return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
  }
}

/**
 * Fetches yesterday's assigned candidates for a CA.
 * If yesterday had 0 records (weekend/holiday), looks back up to 7 days for the latest active day.
 */
export async function fetchAllowedCandidates(caEmail: string): Promise<WorkHistoryResult> {
  let unreachableCount = 0;

  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const dateStr = daysBack === 1 ? getYesterdayIST() : getISTDateString(daysBack);
    const records = await fetchRecordsForDate(caEmail, dateStr);

    if (records === null) {
      unreachableCount++;
      if (daysBack === 1) {
        return { records: [], candidateIds: [], unreachable: true, resolvedDate: null };
      }
      continue;
    }

    if (records.length > 0) {
      return {
        records,
        candidateIds: records.map((r) => r.applywizzId),
        unreachable: false,
        resolvedDate: dateStr,
      };
    }
  }

  return {
    records: [],
    candidateIds: [],
    unreachable: unreachableCount === 7,
    resolvedDate: null,
  };
}
