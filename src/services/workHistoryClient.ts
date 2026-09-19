/**
 * @fileoverview Client for ApplyWizz CA Management Work History API.
 * Queries assigned candidates for a given CA on a specific date (Asia/Kolkata timezone).
 */

import { config } from '../config/env.js';
import { WORK_HISTORY_API_BASE_URL } from '../server/workHistoryAuth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Work History Client');

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
 * Throws an error if caEmail is missing.
 */
export function buildCaWorkHistoryUrl(caEmail: string, dateStr: string): string {
  const email = (caEmail || '').trim().toLowerCase();
  if (!email) {
    throw new Error('[WorkHistory] ❌ CA email missing — cannot proceed');
  }
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
  log.info(`[WorkHistory] Computed yesterday in IST (UTC+5:30): ${date}`);
  return date;
}

const WORK_HISTORY_FETCH_TIMEOUT_MS = 8000;
const WORK_HISTORY_ADMIN_FETCH_TIMEOUT_MS = 15000;
const WORK_HISTORY_MAX_ATTEMPTS = 3;
const WORK_HISTORY_RETRY_BACKOFF_MS = 2000;
/** ApplyWizz work-history default page size (matches CA Management API). */
const WORK_HISTORY_PAGE_SIZE = 50;

const CA_EMAIL_DATE_CACHE_TTL_MS = 60_000;

type CaEmailDateCacheEntry = {
  expiresAt: number;
  records: WorkHistoryCandidateRecord[] | null;
};

/** Recent CA+date fetches (sign-in often triggers parallel identical requests). */
const caEmailDateCache = new Map<string, CaEmailDateCacheEntry>();
const caEmailDateInflight = new Map<string, Promise<WorkHistoryCandidateRecord[] | null>>();

function caEmailDateCacheKey(caEmail: string, dateStr: string): string {
  return `${caEmail.trim().toLowerCase()}|${dateStr}`;
}

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
    log.info(`[WorkHistory] Fetching ${fullUrl}`);
    try {
      const response = await fetch(fullUrl, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true, response };
    } catch (err: unknown) {
      lastReason = err instanceof Error ? err.message : String(err);
      const timedOut = isFetchTimeoutError(err);
      if (timedOut && attempt < WORK_HISTORY_MAX_ATTEMPTS) {
        log.warn(
          `[WorkHistory] Failed ${fullUrl}: ${lastReason} (timeout, retry ${attempt + 1}/${WORK_HISTORY_MAX_ATTEMPTS} in ${WORK_HISTORY_RETRY_BACKOFF_MS}ms)`
        );
        await sleep(WORK_HISTORY_RETRY_BACKOFF_MS);
        continue;
      }
      log.warn(`[WorkHistory] Failed ${fullUrl}: ${lastReason}`);
      return { ok: false, reason: lastReason };
    }
  }

  log.warn(`[WorkHistory] Failed ${fullUrl}: ${lastReason}`);
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
 * Fetches every page for a work-history URL that already includes from/to (and optional filters).
 * Reads `total` from page 1, then requests remaining pages when needed.
 * Returns raw `records` arrays combined, or null on network/HTTP/parse failure.
 */
async function fetchAllWorkHistoryPages(
  urlWithoutPage: string,
  timeoutMs: number
): Promise<unknown[] | null> {
  const sep = urlWithoutPage.includes('?') ? '&' : '?';
  const pageSize = WORK_HISTORY_PAGE_SIZE;
  const page1Url = `${urlWithoutPage}${sep}page=1&pageSize=${pageSize}`;

  const outcome = await fetchWorkHistoryWithRetry(page1Url, timeoutMs);
  if (!outcome.ok) {
    return null;
  }

  const res = outcome.response;
  if (!res.ok) {
    log.warn(`[WorkHistory] Failed ${page1Url}: HTTP ${res.status}`);
    return null;
  }

  let data: any;
  try {
    data = await res.json();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[WorkHistory] Failed ${page1Url}: ${message}`);
    return null;
  }

  if (!data || !Array.isArray(data.records)) {
    log.warn(`[WorkHistory] Failed ${page1Url}: invalid response body (expected records array)`);
    return null;
  }

  const total =
    typeof data.total === 'number' && Number.isFinite(data.total)
      ? data.total
      : data.records.length;
  const effectivePageSize =
    typeof data.pageSize === 'number' && data.pageSize > 0 ? data.pageSize : pageSize;
  const totalPages = Math.ceil(total / effectivePageSize);
  const displayTotalPages = totalPages > 0 ? totalPages : 1;

  log.info(`Work history: fetched page 1 of ${displayTotalPages}`);

  const allRecords: unknown[] = [...data.records];

  if (totalPages > 1) {
    for (let page = 2; page <= totalPages; page++) {
      const pageUrl = `${urlWithoutPage}${sep}page=${page}&pageSize=${effectivePageSize}`;
      const pageOutcome = await fetchWorkHistoryWithRetry(pageUrl, timeoutMs);
      if (!pageOutcome.ok) {
        return null;
      }
      const pageRes = pageOutcome.response;
      if (!pageRes.ok) {
        log.warn(`[WorkHistory] Failed ${pageUrl}: HTTP ${pageRes.status}`);
        return null;
      }
      let pageData: any;
      try {
        pageData = await pageRes.json();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[WorkHistory] Failed ${pageUrl}: ${message}`);
        return null;
      }
      if (!pageData || !Array.isArray(pageData.records)) {
        log.warn(`[WorkHistory] Failed ${pageUrl}: invalid response body (expected records array)`);
        return null;
      }
      allRecords.push(...pageData.records);
      log.info(`Work history: fetched page ${page} of ${displayTotalPages}`);
    }
  }

  return allRecords;
}

async function fetchRecordsForDateFromApi(
  normalizedEmail: string,
  dateStr: string
): Promise<WorkHistoryCandidateRecord[] | null> {
  const fullUrl = buildCaWorkHistoryUrl(normalizedEmail, dateStr);
  log.info(`[WorkHistory] Fetching ${fullUrl}`);
  const rawRecords = await fetchAllWorkHistoryPages(fullUrl, WORK_HISTORY_FETCH_TIMEOUT_MS);
  if (rawRecords === null) {
    return null;
  }

  const records = parseWorkHistoryRecords({ records: rawRecords });
  if (records === null) {
    log.warn(`[WorkHistory] Failed ${fullUrl}: invalid response body (expected records array)`);
    return null;
  }
  log.info(
    `[WorkHistory] Success date=${dateStr} ca_email=${normalizedEmail} records=${records.length}`
  );
  return records;
}

/**
 * Queries work-history API for a specific date (IST) and signed-in CA email.
 * Returns null if network error, HTTP error, or timeout occurs.
 * Dedupes identical ca_email+date requests for 60s (in-memory).
 */
async function fetchRecordsForDate(
  caEmail: string,
  dateStr: string
): Promise<WorkHistoryCandidateRecord[] | null> {
  const normalizedEmail = (caEmail || '').trim().toLowerCase();
  if (!normalizedEmail) {
    log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
    throw new Error('[WorkHistory] ❌ CA email missing — cannot proceed');
  }

  const key = caEmailDateCacheKey(normalizedEmail, dateStr);
  const now = Date.now();
  const cached = caEmailDateCache.get(key);
  if (cached && cached.expiresAt > now) {
    log.info(`[WorkHistory] Cache hit for ${normalizedEmail} ${dateStr}`);
    return cached.records;
  }

  const inflight = caEmailDateInflight.get(key);
  if (inflight) return inflight;

  const promise = fetchRecordsForDateFromApi(normalizedEmail, dateStr).then((records) => {
    caEmailDateCache.set(key, { expiresAt: Date.now() + CA_EMAIL_DATE_CACHE_TTL_MS, records });
    caEmailDateInflight.delete(key);
    return records;
  });
  caEmailDateInflight.set(key, promise);
  return promise;
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

  const rawRecords = await fetchAllWorkHistoryPages(fullUrl, WORK_HISTORY_ADMIN_FETCH_TIMEOUT_MS);
  if (rawRecords === null) {
    return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
  }

  const records = parseWorkHistoryRecords({ records: rawRecords });
  if (records === null) {
    log.warn(`[WorkHistory] Failed ${fullUrl}: invalid response body (expected records array)`);
    return { records: [], candidateIds: [], unreachable: true, resolvedDate: dateStr };
  }
  log.info(`[WorkHistory] Success date=${dateStr} ca_email=(admin) records=${records.length}`);
  return {
    records,
    candidateIds: records.map((r) => r.applywizzId),
    unreachable: false,
    resolvedDate: dateStr,
  };
}

/**
 * Fetches yesterday's assigned candidates for a CA.
 * If yesterday had 0 records (weekend/holiday), looks back up to 7 days for the latest active day.
 */
export function extractCareerAssociateManagerIdFromWorkHistoryPayload(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;

  const direct =
    root.careerassociatemanagerid ??
    root.careerassociatemanager_id ??
    root.careerAssociateManagerId;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim().toLowerCase();
  }

  const records = root.records;
  if (!Array.isArray(records)) return null;

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const row = rec as Record<string, unknown>;
    const id =
      row.careerassociatemanagerid ??
      row.careerassociatemanager_id ??
      row.careerAssociateManagerId;
    if (typeof id === 'string' && id.trim()) {
      return id.trim().toLowerCase();
    }
  }

  return null;
}

/**
 * Work-history lookup for a single candidate (used to read careerassociatemanagerid).
 */
export async function fetchCareerAssociateManagerIdForCandidate(
  applywizzId: string,
  dateStr: string
): Promise<string | null> {
  const id = (applywizzId || '').trim().toUpperCase();
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;

  const base = getWorkHistoryBaseUrl();
  const fullUrl = `${base}?from=${dateStr}&to=${dateStr}&applywizz_id=${encodeURIComponent(id)}`;
  const outcome = await fetchWorkHistoryWithRetry(fullUrl, WORK_HISTORY_FETCH_TIMEOUT_MS);
  if (!outcome.ok) return null;

  const res = outcome.response;
  if (!res.ok) {
    log.warn(`[WorkHistory] Failed ${fullUrl}: HTTP ${res.status}`);
    return null;
  }

  try {
    const data: unknown = await res.json();
    return extractCareerAssociateManagerIdFromWorkHistoryPayload(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[WorkHistory] Failed ${fullUrl}: ${message}`);
    return null;
  }
}

export async function fetchAllowedCandidates(caEmail: string): Promise<WorkHistoryResult> {
  let unreachableCount = 0;

  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const dateStr = daysBack === 1 ? getISTDateString(0) : getISTDateString(daysBack);
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
