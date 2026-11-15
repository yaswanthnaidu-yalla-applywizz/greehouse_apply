import type { Request, Response } from 'express';
import { isSupabaseConfigured, getDbClient } from '../db/client.js';
import { parseDashboardStatsRange, serializeDateRange } from './dashboardDateRange.js';
import { getISTDateRangeUtc } from './dashboardDateRange.js';
import { getISTDateString } from '../services/workHistoryClient.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CandidateVolume');

export interface CandidateVolumeItem {
  applywizzId: string;
  candidateName: string;
  email?: string;
  appliedCount: number;
  emailProofPendingCount: number;
  totalSubmittedCount: number;
}

export interface CandidateVolumeTotals {
  candidateCount: number;
  applied: number;
  emailProofPending: number;
  totalSubmitted: number;
}

export interface CandidateVolumeResponse {
  dateRange: {
    preset: string;
    from: string | null;
    to: string | null;
    label: string;
  };
  totals: CandidateVolumeTotals;
  candidates: CandidateVolumeItem[];
}

export interface CandidateJobProofItem {
  id: string;
  applywizzId: string;
  jobUrl: string;
  companyName: string;
  jobTitle?: string;
  ats: string;
  status: string;
  submittedAt?: string | null;
  createdAt?: string | null;
  proofWebUrl?: string | null;
  proofEmailUrl?: string | null;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlMs = 30000): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

export const candidateVolumeCache = new TtlCache<CandidateVolumeResponse>();
export const candidateApplicationsCache = new TtlCache<{ applications: CandidateJobProofItem[] }>();

export function aggregateCandidateVolumeRows(
  rows: Array<{ id?: string; applywizz_id?: string | null; status: string; created_at?: string | null }>,
  profilesMap: Map<string, { name?: string; email?: string }>
): { totals: CandidateVolumeTotals; candidates: CandidateVolumeItem[] } {
  const map = new Map<string, { applied: number; emailProofPending: number }>();

  let totalApplied = 0;
  let totalEmailProofPending = 0;

  for (const r of rows) {
    const cid = (r.applywizz_id || 'UNKNOWN').trim().toUpperCase();
    if (!map.has(cid)) {
      map.set(cid, { applied: 0, emailProofPending: 0 });
    }
    const entry = map.get(cid)!;
    if (r.status === 'APPLIED') {
      entry.applied++;
      totalApplied++;
    } else if (r.status === 'EMAIL_PROOF_PENDING') {
      entry.emailProofPending++;
      totalEmailProofPending++;
    }
  }

  const candidates: CandidateVolumeItem[] = [];
  for (const [cid, counts] of map.entries()) {
    const profile = profilesMap.get(cid);
    candidates.push({
      applywizzId: cid,
      candidateName: profile?.name || cid,
      email: profile?.email,
      appliedCount: counts.applied,
      emailProofPendingCount: counts.emailProofPending,
      totalSubmittedCount: counts.applied + counts.emailProofPending,
    });
  }

  candidates.sort((a, b) => b.totalSubmittedCount - a.totalSubmittedCount || a.applywizzId.localeCompare(b.applywizzId));

  return {
    totals: {
      candidateCount: candidates.length,
      applied: totalApplied,
      emailProofPending: totalEmailProofPending,
      totalSubmitted: totalApplied + totalEmailProofPending,
    },
    candidates,
  };
}

export async function handleCandidateVolume(req: Request, res: Response): Promise<void> {
  const parsedRange = parseDashboardStatsRange(req.query as Record<string, unknown>);
  if ('error' in parsedRange) {
    res.status(400).json({ error: parsedRange.error });
    return;
  }

  const fromDate = parsedRange.fromDate || getISTDateString();
  const toDate = parsedRange.toDate || getISTDateString();
  const cacheKey = `volume:${parsedRange.preset}:${fromDate}:${toDate}`;

  const cached = candidateVolumeCache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const { startIso } = getISTDateRangeUtc(fromDate);
    const { endIso } = getISTDateRangeUtc(toDate);

    let rows: Array<{ id?: string; applywizz_id?: string | null; status: string; created_at?: string | null }> = [];

    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('id, applywizz_id, status, created_at')
        .in('status', ['APPLIED', 'EMAIL_PROOF_PENDING'])
        .gte('created_at', startIso)
        .lt('created_at', endIso);

      if (!error && data) {
        rows = data;
      } else if (error) {
        log.warn(`Candidate volume Supabase query failed: ${error.message}`);
      }
    }

    const uniqueCids = Array.from(new Set(rows.map((r) => (r.applywizz_id || '').trim().toUpperCase()).filter(Boolean)));
    const profilesMap = new Map<string, { name?: string; email?: string }>();

    if (uniqueCids.length > 0 && isSupabaseConfigured()) {
      const supabase = getDbClient();
      for (let i = 0; i < uniqueCids.length; i += 50) {
        const chunk = uniqueCids.slice(i, i + 50);
        const { data: profs } = await supabase
          .from('profiles')
          .select('applywizz_id, full_name, email')
          .in('applywizz_id', chunk);

        for (const p of profs || []) {
          const cid = (p.applywizz_id || '').trim().toUpperCase();
          profilesMap.set(cid, {
            name: p.full_name || p.email || cid,
            email: p.email,
          });
        }
      }
    }

    const { totals, candidates } = aggregateCandidateVolumeRows(rows, profilesMap);

    const payload: CandidateVolumeResponse = {
      dateRange: serializeDateRange(parsedRange),
      totals,
      candidates,
    };

    candidateVolumeCache.set(cacheKey, payload, 30000);
    res.json(payload);
  } catch (err: any) {
    log.error(`Candidate volume handler error: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve candidate volume statistics.' });
  }
}

export async function handleCandidateSubmittedApplications(req: Request, res: Response): Promise<void> {
  const applywizzId = String(req.params.applywizzId || '').trim().toUpperCase();
  if (!applywizzId) {
    res.status(400).json({ error: 'applywizzId parameter is required.' });
    return;
  }

  const parsedRange = parseDashboardStatsRange(req.query as Record<string, unknown>);
  if ('error' in parsedRange) {
    res.status(400).json({ error: parsedRange.error });
    return;
  }

  const fromDate = parsedRange.fromDate || getISTDateString();
  const toDate = parsedRange.toDate || getISTDateString();
  const cacheKey = `cand_apps:${applywizzId}:${parsedRange.preset}:${fromDate}:${toDate}`;

  const cached = candidateApplicationsCache.get(cacheKey);
  if (cached) {
    res.json(cached);
    return;
  }

  try {
    const { startIso } = getISTDateRangeUtc(fromDate);
    const { endIso } = getISTDateRangeUtc(toDate);

    let applications: CandidateJobProofItem[] = [];

    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('id, applywizz_id, job_url, company_name, job_title, ats, status, submitted_at, created_at, proof_web_url, proof_email_url')
        .eq('applywizz_id', applywizzId)
        .in('status', ['APPLIED', 'EMAIL_PROOF_PENDING'])
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('submitted_at', { ascending: false });

      if (!error && data) {
        applications = data.map((d: any) => ({
          id: d.id,
          applywizzId: d.applywizz_id,
          jobUrl: d.job_url,
          companyName: d.company_name || 'Unknown Company',
          jobTitle: d.job_title || 'Software Engineer',
          ats: d.ats || 'greenhouse',
          status: d.status,
          submittedAt: d.submitted_at,
          createdAt: d.created_at,
          proofWebUrl: d.proof_web_url || null,
          proofEmailUrl: d.proof_email_url || null,
        }));
      }
    }

    const payload = { applications };
    candidateApplicationsCache.set(cacheKey, payload, 30000);
    res.json(payload);
  } catch (err: any) {
    log.error(`Candidate submitted jobs handler error: ${err.message}`);
    res.status(500).json({ error: 'Failed to retrieve candidate applications.' });
  }
}
