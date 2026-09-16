import {
  ADMIN_WORK_HISTORY_CACHE_KEY,
  fetchAdminWorkHistoryForDate,
  fetchWorkHistoryForDate,
  type WorkHistoryCandidateRecord,
} from '../services/workHistoryClient.js';

export type { WorkHistoryCandidateRecord };
import { getCachedWorkHistory, setCachedWorkHistory } from './workHistoryCache.js';

export async function mergeWorkHistoryForIstDates(options: {
  mode: 'admin' | 'ca';
  caEmail: string;
  dates: string[];
}): Promise<{
  records: WorkHistoryCandidateRecord[];
  candidateIds: string[];
  unreachable: boolean;
}> {
  const seenIds = new Set<string>();
  const records: WorkHistoryCandidateRecord[] = [];
  const recordIds = new Set<string>();
  let unreachable = false;

  for (const date of options.dates) {
    const cacheKey = options.mode === 'admin' ? ADMIN_WORK_HISTORY_CACHE_KEY : options.caEmail;
    let cached = getCachedWorkHistory(cacheKey, date);
    if (!cached) {
      const whResult =
        options.mode === 'admin'
          ? await fetchAdminWorkHistoryForDate(date)
          : await fetchWorkHistoryForDate(options.caEmail, date);
      setCachedWorkHistory(
        cacheKey,
        whResult.records,
        whResult.candidateIds,
        whResult.unreachable,
        whResult.resolvedDate,
        date
      );
      cached = {
        records: whResult.records,
        candidateIds: whResult.candidateIds,
        expiresAt: Date.now() + 5 * 60 * 1000,
        unreachable: whResult.unreachable,
        resolvedDate: whResult.resolvedDate,
      };
    }
    unreachable = unreachable || cached.unreachable;
    for (const id of cached.candidateIds) {
      seenIds.add(id.toUpperCase());
    }
    for (const rec of cached.records) {
      const key = rec.applywizzId.toUpperCase();
      if (recordIds.has(key)) continue;
      recordIds.add(key);
      records.push(rec);
    }
  }

  return {
    records,
    candidateIds: Array.from(seenIds),
    unreachable,
  };
}

/** Merges work-history across multiple operator CA emails (manager team view). */
export async function mergeWorkHistoryForCaEmails(
  caEmails: string[],
  dates: string[]
): Promise<{
  records: WorkHistoryCandidateRecord[];
  candidateIds: string[];
  unreachable: boolean;
}> {
  const emails = [...new Set(caEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) {
    return { records: [], candidateIds: [], unreachable: false };
  }

  const seenIds = new Set<string>();
  const records: WorkHistoryCandidateRecord[] = [];
  const recordIds = new Set<string>();
  let unreachable = false;

  for (const email of emails) {
    const merged = await mergeWorkHistoryForIstDates({ mode: 'ca', caEmail: email, dates });
    unreachable = unreachable || merged.unreachable;
    for (const id of merged.candidateIds) {
      seenIds.add(id.toUpperCase());
    }
    for (const rec of merged.records) {
      const key = rec.applywizzId.toUpperCase();
      if (recordIds.has(key)) continue;
      recordIds.add(key);
      records.push(rec);
    }
  }

  return {
    records,
    candidateIds: Array.from(seenIds),
    unreachable,
  };
}
