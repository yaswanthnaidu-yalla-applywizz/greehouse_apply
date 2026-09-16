/**
 * Paginated fetch for ApplyWizz CA work-history (org-wide date range).
 */

import fs from 'fs';
import path from 'path';

export const DEFAULT_WORK_HISTORY_FROM = '2026-09-14';
export const DEFAULT_WORK_HISTORY_TO = '2026-09-14';
export const WORK_HISTORY_PAGE_SIZE = 50;

const WORK_HISTORY_BASE =
  'https://applywizz-ca-management.vercel.app/api/ca/work-history';

export interface WorkHistoryRow {
  applywizz_id: string;
  ca_email: string;
}

type WorkHistoryApiResponse = {
  total?: number;
  page?: number;
  pageSize?: number;
  records?: unknown[];
};

function normalizeApplywizzId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function normalizeCaEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function parseRecord(row: unknown): WorkHistoryRow | null {
  if (!row || typeof row !== 'object') return null;
  const rec = row as Record<string, unknown>;
  const applywizz_id = normalizeApplywizzId(rec.applywizz_id);
  const ca_email = normalizeCaEmail(rec.ca_email);
  if (!applywizz_id || !ca_email) return null;
  return { applywizz_id, ca_email };
}

const WORK_HISTORY_CACHE_PATH = path.join(
  process.cwd(),
  'scripts',
  '.ca-work-history-cache.json'
);

type WorkHistoryCacheFile = {
  from: string;
  to: string;
  rows: WorkHistoryRow[];
  fetchedAt: string;
};

function readWorkHistoryCache(from: string, to: string): WorkHistoryRow[] | null {
  try {
    if (!fs.existsSync(WORK_HISTORY_CACHE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(WORK_HISTORY_CACHE_PATH, 'utf8')) as WorkHistoryCacheFile;
    if (parsed.from === from && parsed.to === to && Array.isArray(parsed.rows)) {
      console.log(
        `[Backfill] Using cached work history (${parsed.rows.length} rows, fetched ${parsed.fetchedAt})`
      );
      return parsed.rows;
    }
  } catch {
    return null;
  }
  return null;
}

function writeWorkHistoryCache(from: string, to: string, rows: WorkHistoryRow[]): void {
  const payload: WorkHistoryCacheFile = {
    from,
    to,
    rows,
    fetchedAt: new Date().toISOString(),
  };
  fs.writeFileSync(WORK_HISTORY_CACHE_PATH, JSON.stringify(payload));
}

export async function fetchAllWorkHistoryRows(options?: {
  from?: string;
  to?: string;
  pageSize?: number;
  useCache?: boolean;
}): Promise<WorkHistoryRow[]> {
  const from = options?.from ?? DEFAULT_WORK_HISTORY_FROM;
  const to = options?.to ?? DEFAULT_WORK_HISTORY_TO;
  const pageSize = options?.pageSize ?? WORK_HISTORY_PAGE_SIZE;
  const useCache = options?.useCache !== false;

  if (useCache) {
    const cached = readWorkHistoryCache(from, to);
    if (cached) return cached;
  }

  const byApplywizzId = new Map<string, WorkHistoryRow>();
  let page = 1;
  let total = Infinity;

  while (page === 1 || (page - 1) * pageSize < total) {
    const url = `${WORK_HISTORY_BASE}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${page}&pageSize=${pageSize}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new Error(`Work-history HTTP ${response.status} for page ${page}`);
    }

    const body = (await response.json()) as WorkHistoryApiResponse;
    if (typeof body.total === 'number' && Number.isFinite(body.total)) {
      total = body.total;
    }

    const records = Array.isArray(body.records) ? body.records : [];
    if (records.length === 0) break;

    for (const rec of records) {
      const parsed = parseRecord(rec);
      if (parsed) byApplywizzId.set(parsed.applywizz_id, parsed);
    }

    console.log(
      `[Backfill] Work-history page ${page} — ${byApplywizzId.size} unique ids (total ${total})`
    );

    if (records.length < pageSize) break;
    page += 1;
  }

  const rows = Array.from(byApplywizzId.values());
  if (useCache) {
    writeWorkHistoryCache(from, to, rows);
  }
  return rows;
}

/** Latest applywizz_id seen per ca_email (for client-details manager lookup). */
export function sampleApplywizzIdByCaEmail(rows: WorkHistoryRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.ca_email, row.applywizz_id);
  }
  return map;
}
