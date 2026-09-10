/**
 * @fileoverview Client for ApplyWizz CA Management Work History API.
 * Queries assigned candidates for a given CA on a specific date (Asia/Kolkata timezone).
 */

import { config } from '../config/env.js';

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

/**
 * Queries work-history API for a specific date (IST).
 * Returns null if network error, HTTP error, or timeout occurs.
 */
async function fetchRecordsForDate(
  caEmail: string,
  dateStr: string
): Promise<WorkHistoryCandidateRecord[] | null> {
  const baseUrl = config.WORK_HISTORY_API_URL || 'https://applywizz-ca-management.vercel.app/api/ca/work-history';
  const url = `${baseUrl}?from=${dateStr}&to=${dateStr}&ca_email=${encodeURIComponent(caEmail.trim().toLowerCase())}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[WorkHistory] ⚠️ HTTP ${res.status} when querying date ${dateStr} for ${caEmail}`);
      return null;
    }
    const data: any = await res.json();
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
  } catch (err: any) {
    console.warn(`[WorkHistory] ⚠️ Network/Timeout failure on ${dateStr}: ${err.message}`);
    return null;
  }
}

/**
 * Fetches yesterday's assigned candidates for a CA.
 * If yesterday had 0 records (weekend/holiday), looks back up to 7 days for the latest active day.
 */
export async function fetchAllowedCandidates(caEmail: string): Promise<WorkHistoryResult> {
  let unreachableCount = 0;

  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const dateStr = getISTDateString(daysBack);
    const records = await fetchRecordsForDate(caEmail, dateStr);

    if (records === null) {
      unreachableCount++;
      if (daysBack === 1) {
        // If primary attempt fails, mark unreachable
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
