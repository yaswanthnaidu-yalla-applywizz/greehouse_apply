import type { Request, Response } from 'express';
import { isSupabaseConfigured, getDbClient } from '../db/client.js';
import { getISTDateRangeUtc, getIstCalendarDate, listIstDatesInclusive } from './dashboardDateRange.js';
import { getISTDateString } from '../services/workHistoryClient.js';
import { isSuccessStatus, isFailedStatus } from '../db/applicationStats.js';
import { listApplications } from '../db/applications.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AnalysisStats');

export interface AnalysisSummary {
  total: number;
  applied: number;
  failed: number;
  clients: number;
  successRate: number;
  failureRate: number;
  retryableFailed: number;
}

export interface AnalysisTimelinePoint {
  date: string;
  total: number;
  applied: number;
  failed: number;
  clients: number;
}

export interface FailureApplicationItem {
  id: string;
  applywizzId: string;
  jobUrl: string;
  companyName: string;
  jobTitle?: string;
  ats: 'greenhouse' | 'ashby';
  errorMessage: string;
  createdAt: string;
}

export interface FailureReasonGroup {
  reason: string;
  category: string;
  isRetryable: boolean;
  count: number;
  percentage: number;
  applications: FailureApplicationItem[];
}

export interface AnalysisResponse {
  mode: 'date' | 'period';
  range: {
    fromDate: string;
    toDate: string;
    label: string;
  };
  ats: 'all' | 'greenhouse' | 'ashby';
  summary: AnalysisSummary;
  timeline: AnalysisTimelinePoint[];
  failures: FailureReasonGroup[];
}

export interface NormalizedFailureReason {
  reason: string;
  category: string;
  isRetryable: boolean;
}

export function normalizeFailureReason(rawMessage: string | null | undefined): NormalizedFailureReason {
  if (!rawMessage || !rawMessage.trim()) {
    return { reason: 'Unknown failure', category: 'Other', isRetryable: false };
  }
  const msg = rawMessage.trim();

  // 1. Page navigation / load timeout & browser launch failures (Retryable)
  if (/navigation timeout|timeout.*exceeded|timed out waiting for|page load timeout|browser launch failed/i.test(msg)) {
    return { reason: 'Page navigation / load timeout', category: 'Network / Timeout', isRetryable: true };
  }

  // 2. OTP retrieval / submission timeout (Retryable)
  if (/\botp\b.*(time.?out|timed out)|failed to retrieve.*otp|otp not received|otp submission/i.test(msg)) {
    return { reason: 'OTP retrieval / submission timeout', category: 'OTP', isRetryable: true };
  }

  // 4. Rate limited (HTTP 429) (Retryable)
  if (/rate limit|too many requests|429/i.test(msg)) {
    return { reason: 'Rate limited by job board', category: 'Rate Limit', isRetryable: true };
  }

  // 8. Anti-bot / CAPTCHA challenge (Retryable with fresh residential IP/session)
  if (/cloudflare|turnstile|captcha|anti-bot|bot detection/i.test(msg)) {
    return { reason: 'Anti-bot / CAPTCHA challenge encountered', category: 'Bot Challenge', isRetryable: true };
  }

  // 3. Email verification timeout (Terminal per policy)
  if (/verification email.*(time.?out|timed out)|email proof.*(time.?out|timed out)|did not receive.*email|email verification/i.test(msg)) {
    return { reason: 'Email verification timeout', category: 'Email Verification', isRetryable: false };
  }

  // 5. Mandatory cover letter required (Terminal per policy)
  if (/cover letter/i.test(msg)) {
    return { reason: 'Mandatory cover letter required', category: 'Validation', isRetryable: false };
  }

  // 6. Required field empty or unmapped (Terminal per policy)
  if (/required field.*empty|missing required|required field unresolved/i.test(msg)) {
    return { reason: 'Required field empty or unmapped', category: 'Form Fill', isRetryable: false };
  }

  // Resume issues (Terminal)
  if (/resume.*missing|resume.*download|resume.*parse/i.test(msg)) {
    return { reason: 'Resume missing or unparseable', category: 'Resume', isRetryable: false };
  }

  // Selector miss or submit button not found (Terminal)
  if (/selector|no submit button|element not found|button not visible/i.test(msg)) {
    return { reason: 'Selector miss or submit button not found', category: 'Form Fill', isRetryable: false };
  }

  // 7. Duplicate / already applied (Terminal)
  if (/already applied/i.test(msg)) {
    return { reason: 'Already applied previously', category: 'Duplicate', isRetryable: false };
  }

  // 7. Job closed / expired (Terminal)
  if (/job (expired|closed|no longer available)/i.test(msg)) {
    return { reason: 'Job expired or closed', category: 'Job Availability', isRetryable: false };
  }

  // Generic sanitized fallback
  const cleaned = msg
    .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<id>')
    .replace(/\b\d{4,}\b/g, '<num>')
    .slice(0, 110);

  return { reason: cleaned, category: 'General Failure', isRetryable: false };
}

export function computeDateOffset(baseIsoDate: string, daysBack: number): string {
  const [y, m, d] = baseIsoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() - daysBack);
  return getIstCalendarDate(date).isoDate;
}

export async function handleAnalysisStats(req: Request, res: Response): Promise<void> {
  try {
    const today = getISTDateString();
    const mode = req.query.mode === 'date' ? 'date' : 'period';
    const atsFilter = (
      req.query.ats === 'greenhouse' || req.query.ats === 'ashby' ? req.query.ats : 'all'
    ) as 'all' | 'greenhouse' | 'ashby';

    let fromDate: string;
    let toDate: string;
    let label = '';

    if (mode === 'date') {
      const singleDate = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : today;
      fromDate = singleDate;
      toDate = singleDate;
      label = singleDate;
    } else {
      const preset = typeof req.query.preset === 'string' ? req.query.preset : '7d';
      if (preset === '14d') {
        fromDate = computeDateOffset(today, 13);
        toDate = today;
        label = 'Last 14 Days';
      } else if (preset === '30d') {
        fromDate = computeDateOffset(today, 29);
        toDate = today;
        label = 'Last 30 Days';
      } else if (preset === 'custom') {
        const queryFrom = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
          ? req.query.from
          : computeDateOffset(today, 6);
        const queryTo = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
          ? req.query.to
          : today;
        if (queryFrom <= queryTo) {
          fromDate = queryFrom;
          toDate = queryTo;
        } else {
          fromDate = queryTo;
          toDate = queryFrom;
        }
        label = `${fromDate} to ${toDate}`;
      } else {
        // default 7d
        fromDate = computeDateOffset(today, 6);
        toDate = today;
        label = 'Last 7 Days';
      }
    }

    const { startIso } = getISTDateRangeUtc(fromDate);
    const { endIso } = getISTDateRangeUtc(toDate);

    interface RawAppRow {
      id?: string;
      applywizz_id?: string | null;
      job_url?: string | null;
      company_name?: string | null;
      job_title?: string | null;
      status: string;
      error_message?: string | null;
      ats?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
    }

    let rows: RawAppRow[] = [];

    if (isSupabaseConfigured()) {
      try {
        const supabase = getDbClient();
        let query = supabase
          .from('gh_candidate_applications')
          .select('id, applywizz_id, job_url, company_name, job_title, status, error_message, ats, created_at, updated_at')
          .gte('created_at', startIso)
          .lt('created_at', endIso);

        if (atsFilter !== 'all') {
          query = query.eq('ats', atsFilter);
        }

        const { data, error } = await query;
        if (!error && data) {
          rows = data as RawAppRow[];
        } else if (error) {
          log.warn(`Supabase query failed in analysisStats, falling back to local: ${error.message}`);
        }
      } catch (err: any) {
        log.warn(`Supabase connection failed in analysisStats, falling back to local: ${err.message}`);
      }
    }

    if (rows.length === 0) {
      const allApps = await listApplications();
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      rows = allApps.filter((r) => {
        const at = Date.parse(r.created_at || '');
        return Number.isFinite(at) && at >= start && at < end;
      });
    }

    // Filter by ATS if not Supabase or if ats is derived from job_url
    const filteredRows = rows.filter((row) => {
      const isAshby = row.ats === 'ashby' || (row.job_url && /ashbyhq\.com/i.test(row.job_url));
      const rowAts = isAshby ? 'ashby' : 'greenhouse';
      if (atsFilter !== 'all' && rowAts !== atsFilter) {
        return false;
      }
      return true;
    });

    const dateList = listIstDatesInclusive(fromDate, toDate);
    const timelineMap = new Map<string, { total: number; applied: number; failed: number; clientSet: Set<string> }>();
    for (const d of dateList) {
      timelineMap.set(d, { total: 0, applied: 0, failed: 0, clientSet: new Set<string>() });
    }

    const globalClientSet = new Set<string>();
    let totalApplied = 0;
    let totalFailed = 0;
    let totalRetryableFailed = 0;
    const failureGroupsMap = new Map<string, {
      reason: string;
      category: string;
      isRetryable: boolean;
      count: number;
      applications: FailureApplicationItem[];
    }>();

    for (const row of filteredRows) {
      const createdDate = row.created_at ? getIstCalendarDate(new Date(row.created_at)).isoDate : fromDate;
      const bucket = timelineMap.get(createdDate);

      const isSuccess = isSuccessStatus(row.status);
      const isFail = isFailedStatus(row.status);
      const clientId = String(row.applywizz_id || '').trim();

      if (bucket) {
        bucket.total++;
        if (isSuccess) bucket.applied++;
        if (isFail) bucket.failed++;
        if (clientId) bucket.clientSet.add(clientId);
      }

      if (clientId) globalClientSet.add(clientId);
      if (isSuccess) totalApplied++;
      if (isFail) {
        totalFailed++;
        const norm = normalizeFailureReason(row.error_message);
        if (norm.isRetryable) {
          totalRetryableFailed++;
        }
        const groupKey = `${norm.category}::${norm.reason}`;
        let group = failureGroupsMap.get(groupKey);
        if (!group) {
          group = {
            reason: norm.reason,
            category: norm.category,
            isRetryable: norm.isRetryable,
            count: 0,
            applications: [],
          };
          failureGroupsMap.set(groupKey, group);
        }
        group.count++;

        const isAshby = row.ats === 'ashby' || (row.job_url && /ashbyhq\.com/i.test(row.job_url));
        if (group.applications.length < 25) {
          group.applications.push({
            id: row.id || '',
            applywizzId: clientId || 'UNKNOWN',
            jobUrl: row.job_url || '',
            companyName: row.company_name || 'Unknown Company',
            jobTitle: row.job_title || 'Position',
            ats: isAshby ? 'ashby' : 'greenhouse',
            errorMessage: (row.error_message || '').trim() || norm.reason,
            createdAt: row.created_at || row.updated_at || new Date().toISOString(),
          });
        }
      }
    }

    const timeline: AnalysisTimelinePoint[] = dateList.map((d) => {
      const b = timelineMap.get(d)!;
      return {
        date: d,
        total: b.total,
        applied: b.applied,
        failed: b.failed,
        clients: b.clientSet.size,
      };
    });

    const totalApplications = filteredRows.length;
    const summary: AnalysisSummary = {
      total: totalApplications,
      applied: totalApplied,
      failed: totalFailed,
      clients: globalClientSet.size,
      successRate: totalApplications > 0 ? Number(((totalApplied / totalApplications) * 100).toFixed(1)) : 0,
      failureRate: totalApplications > 0 ? Number(((totalFailed / totalApplications) * 100).toFixed(1)) : 0,
      retryableFailed: totalRetryableFailed,
    };

    const failures: FailureReasonGroup[] = Array.from(failureGroupsMap.values())
      .map((g) => ({
        reason: g.reason,
        category: g.category,
        isRetryable: g.isRetryable,
        count: g.count,
        percentage: totalFailed > 0 ? Number(((g.count / totalFailed) * 100).toFixed(1)) : 0,
        applications: g.applications,
      }))
      .sort((a, b) => b.count - a.count);

    const responsePayload: AnalysisResponse = {
      mode,
      range: {
        fromDate,
        toDate,
        label,
      },
      ats: atsFilter,
      summary,
      timeline,
      failures,
    };

    res.json(responsePayload);
  } catch (error: any) {
    log.error('handleAnalysisStats failed:', error);
    res.status(500).json({ error: 'Unable to load analysis statistics.' });
  }
}

export async function handleRequeueRetryable(req: Request, res: Response): Promise<void> {
  try {
    const today = getISTDateString();
    const mode = req.body?.mode === 'date' ? 'date' : 'period';
    const atsFilter = (
      req.body?.ats === 'greenhouse' || req.body?.ats === 'ashby' ? req.body.ats : 'all'
    ) as 'all' | 'greenhouse' | 'ashby';
    const specificReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : null;

    let fromDate: string;
    let toDate: string;

    if (mode === 'date') {
      const singleDate = typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
        ? req.body.date
        : today;
      fromDate = singleDate;
      toDate = singleDate;
    } else {
      const preset = typeof req.body?.preset === 'string' ? req.body.preset : '7d';
      if (preset === '14d') {
        fromDate = computeDateOffset(today, 13);
        toDate = today;
      } else if (preset === '30d') {
        fromDate = computeDateOffset(today, 29);
        toDate = today;
      } else if (preset === 'custom') {
        const queryFrom = typeof req.body?.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.from)
          ? req.body.from
          : computeDateOffset(today, 6);
        const queryTo = typeof req.body?.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.to)
          ? req.body.to
          : today;
        if (queryFrom <= queryTo) {
          fromDate = queryFrom;
          toDate = queryTo;
        } else {
          fromDate = queryTo;
          toDate = queryFrom;
        }
      } else {
        fromDate = computeDateOffset(today, 6);
        toDate = today;
      }
    }

    const { startIso } = getISTDateRangeUtc(fromDate);
    const { endIso } = getISTDateRangeUtc(toDate);

    interface FailedCandidateRow {
      id?: string;
      applywizz_id?: string | null;
      job_url?: string | null;
      status: string;
      error_message?: string | null;
      ats?: string | null;
      retry_count?: number | null;
      created_at?: string | null;
    }

    let rows: FailedCandidateRow[] = [];

    if (isSupabaseConfigured()) {
      try {
        const supabase = getDbClient();
        let query = supabase
          .from('gh_candidate_applications')
          .select('id, applywizz_id, job_url, status, error_message, ats, retry_count, created_at')
          .eq('status', 'FAILED')
          .gte('created_at', startIso)
          .lt('created_at', endIso);

        if (atsFilter !== 'all') {
          query = query.eq('ats', atsFilter);
        }

        const { data, error } = await query;
        if (!error && data) {
          rows = data as FailedCandidateRow[];
        } else if (error) {
          log.warn(`Supabase query failed in requeue, falling back to local: ${error.message}`);
        }
      } catch (err: any) {
        log.warn(`Supabase connection failed in requeue, falling back to local: ${err.message}`);
      }
    }

    if (rows.length === 0) {
      const allApps = await listApplications({ status: 'FAILED' });
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      rows = allApps.filter((r) => {
        const at = Date.parse(r.created_at || '');
        return Number.isFinite(at) && at >= start && at < end;
      });
    }

    // Filter by ATS if not Supabase or ats is in job_url
    const matchingRows = rows.filter((row) => {
      const isAshby = row.ats === 'ashby' || (row.job_url && /ashbyhq\.com/i.test(row.job_url));
      const rowAts = isAshby ? 'ashby' : 'greenhouse';
      if (atsFilter !== 'all' && rowAts !== atsFilter) {
        return false;
      }
      return true;
    });

    // Filter to retryable and max 3 retries
    const eligibleAppIds: string[] = [];
    for (const row of matchingRows) {
      if (!row.id) continue;
      const currentRetries = Number(row.retry_count ?? 0);
      if (currentRetries >= 3) {
        continue; // Max 3 retries policy
      }
      const norm = normalizeFailureReason(row.error_message);
      if (!norm.isRetryable) {
        continue;
      }
      if (specificReason && norm.reason !== specificReason) {
        continue;
      }
      eligibleAppIds.push(row.id);
    }

    if (eligibleAppIds.length === 0) {
      res.json({
        success: true,
        requeuedCount: 0,
        message: 'No eligible retryable failed applications found to requeue.',
      });
      return;
    }

    const updatePayload = {
      status: 'QUEUED' as const,
      retry_count: 0,
      error_message: null,
      submission_order: 0,
      updated_at: new Date().toISOString(),
    };

    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      for (let i = 0; i < eligibleAppIds.length; i += 200) {
        const chunk = eligibleAppIds.slice(i, i + 200);
        const { error: updateError } = await supabase
          .from('gh_candidate_applications')
          .update(updatePayload)
          .in('id', chunk);
        if (updateError) {
          log.error('Failed to batch requeue applications in Supabase:', updateError);
          throw updateError;
        }
      }
    }

    log.info(`[Requeue] Successfully requeued ${eligibleAppIds.length} retryable applications`);
    res.json({
      success: true,
      requeuedCount: eligibleAppIds.length,
      message: `Successfully requeued ${eligibleAppIds.length} retryable applications.`,
    });
  } catch (error: any) {
    log.error('handleRequeueRetryable failed:', error);
    res.status(500).json({ error: error.message || 'Failed to requeue applications.' });
  }
}
