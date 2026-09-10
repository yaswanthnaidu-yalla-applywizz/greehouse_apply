/**
 * @fileoverview In-memory TTL Cache for CA Work-History Candidate Access.
 * 5-minute TTL per CA email.
 */

import type { WorkHistoryCandidateRecord } from '../services/workHistoryClient.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface CachedWorkHistory {
  records: WorkHistoryCandidateRecord[];
  candidateIds: string[];
  expiresAt: number;
  unreachable: boolean;
  resolvedDate: string | null;
}

const _cache = new Map<string, CachedWorkHistory>();

export function getCachedWorkHistory(email: string): CachedWorkHistory | null {
  const normalized = email.trim().toLowerCase();
  const entry = _cache.get(normalized);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(normalized);
    return null;
  }
  return entry;
}

export function setCachedWorkHistory(
  email: string,
  records: WorkHistoryCandidateRecord[],
  candidateIds: string[],
  unreachable: boolean,
  resolvedDate: string | null = null
): void {
  const normalized = email.trim().toLowerCase();
  _cache.set(normalized, {
    records,
    candidateIds: candidateIds.map((id) => id.toUpperCase()),
    expiresAt: Date.now() + TTL_MS,
    unreachable,
    resolvedDate,
  });
}

export function clearCachedWorkHistory(email?: string): void {
  if (email) _cache.delete(email.trim().toLowerCase());
  else _cache.clear();
}
