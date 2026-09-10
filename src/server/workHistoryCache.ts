/**
 * @fileoverview In-memory TTL Cache for CA Work-History Candidate Access.
 * 5-minute TTL per CA email.
 */

import type { WorkHistoryCandidateRecord } from '../services/workHistoryClient.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const _cache = new Map<string, CachedWorkHistory>();

export interface CachedWorkHistory {
  records: WorkHistoryCandidateRecord[];
  candidateIds: string[];
  expiresAt: number;
  unreachable: boolean;
  resolvedDate: string | null;
}

const buildKey = (email: string, dateStr?: string | null): string => {
  const normEmail = email.trim().toLowerCase();
  const normDate = dateStr ? dateStr.trim() : 'default';
  return `${normEmail}::${normDate}`;
};

export function getCachedWorkHistory(email: string, dateStr?: string | null): CachedWorkHistory | null {
  const key = buildKey(email, dateStr);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry;
}

export function setCachedWorkHistory(
  email: string,
  records: WorkHistoryCandidateRecord[],
  candidateIds: string[],
  unreachable: boolean,
  resolvedDate: string | null = null,
  dateStr?: string | null
): void {
  const key = buildKey(email, dateStr || resolvedDate);
  _cache.set(key, {
    records,
    candidateIds: candidateIds.map((id) => id.toUpperCase()),
    expiresAt: Date.now() + TTL_MS,
    unreachable,
    resolvedDate,
  });
}

export function clearCachedWorkHistory(email?: string, dateStr?: string | null): void {
  if (email) {
    if (dateStr) {
      _cache.delete(buildKey(email, dateStr));
    } else {
      const prefix = `${email.trim().toLowerCase()}::`;
      for (const k of Array.from(_cache.keys())) {
        if (k.startsWith(prefix)) {
          _cache.delete(k);
        }
      }
    }
  } else {
    _cache.clear();
  }
}
