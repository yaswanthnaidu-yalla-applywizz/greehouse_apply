import { config } from '../config/env.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { getLatestIngestRunDate } from '../db/ingestRuns.js';
import { getISTDateRangeUtc } from '../server/dashboardDateRange.js';
import { isAshbyUrl, isGreenhouseUrl } from '../scanner/atsDetector.js';
import { normalizeFailureReason } from '../server/analysisStats.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ExecutiveDailyReport');

const DEV_EMAIL = 'yaswanthnaiduyalla@applywizz.ai';
const PROD_EXECUTIVE_DAILY_TO = ['ramakrishna@applywizz.ai'];
const PROD_EXECUTIVE_DAILY_CC = [
  'anushabandreddy@applywizz.ai',
  'yaswanthnaiduyalla@applywizz.ai',
  'vivek@applywizz.ai',
];

export function resolveExecutiveDailyReportRecipients(): { to: string[]; cc: string[] } {
  const isSandbox = process.env.SANDBOX === 'true' || process.env.SANDBOX === '1';
  const override = String(process.env.CA_NOTIFICATION_EMAIL_OVERRIDE || config.CA_NOTIFICATION_EMAIL_OVERRIDE || '')
    .trim()
    .toLowerCase();

  if (override) {
    return { to: [override], cc: [] };
  }
  if (isSandbox) {
    return { to: [DEV_EMAIL], cc: [] };
  }
  return {
    to: [...PROD_EXECUTIVE_DAILY_TO],
    cc: [...PROD_EXECUTIVE_DAILY_CC],
  };
}

export interface AtsStats {
  total: number;
  applied: number;
  failed: number;
  queued: number;
  readyForReview: number;
  other: number;
}

export interface FailureReasonCount {
  reason: string;
  category: string;
  count: number;
}

export interface ExecutiveDailyReportData {
  targetDate: string; // YYYY-MM-DD IST
  runStartedAt?: string;
  totalApplications: number;
  totalApplied: number;
  totalFailed: number;
  totalQueued: number;
  totalReadyForReview: number;
  successRatePercent: number;
  completionRatePercent: number;
  atsBreakdown: {
    greenhouse: AtsStats;
    ashby: AtsStats;
    other: AtsStats;
  };
  failureReasons: FailureReasonCount[];
  executiveSummary: string;
}

function emptyAtsStats(): AtsStats {
  return { total: 0, applied: 0, failed: 0, queued: 0, readyForReview: 0, other: 0 };
}

export function aggregateIngestRunMetrics(
  rows: Array<{ id: string; status: string; job_url?: string; error_message?: string | null }>,
  targetDate: string,
  runStartedAt?: string
): ExecutiveDailyReportData {
  const atsBreakdown = {
    greenhouse: emptyAtsStats(),
    ashby: emptyAtsStats(),
    other: emptyAtsStats(),
  };

  const failureMap = new Map<string, { reason: string; category: string; count: number }>();

  let totalApplied = 0;
  let totalFailed = 0;
  let totalQueued = 0;
  let totalReadyForReview = 0;

  for (const row of rows) {
    const status = String(row.status || '').trim().toUpperCase();
    const url = String(row.job_url || '');

    let atsKey: 'greenhouse' | 'ashby' | 'other' = 'other';
    if (isGreenhouseUrl(url)) {
      atsKey = 'greenhouse';
    } else if (isAshbyUrl(url)) {
      atsKey = 'ashby';
    }

    const bucket = atsBreakdown[atsKey];
    bucket.total += 1;

    switch (status) {
      case 'APPLIED':
        totalApplied += 1;
        bucket.applied += 1;
        break;
      case 'FAILED':
        totalFailed += 1;
        bucket.failed += 1;
        {
          const norm = normalizeFailureReason(row.error_message);
          const key = norm.reason;
          const existing = failureMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            failureMap.set(key, { reason: norm.reason, category: norm.category, count: 1 });
          }
        }
        break;
      case 'QUEUED':
        totalQueued += 1;
        bucket.queued += 1;
        break;
      case 'READY_FOR_REVIEW':
        totalReadyForReview += 1;
        bucket.readyForReview += 1;
        break;
      default:
        bucket.other += 1;
        break;
    }
  }

  const totalApplications = rows.length;
  const terminalCount = totalApplied + totalFailed;
  const successRatePercent = terminalCount > 0 ? Number(((totalApplied / terminalCount) * 100).toFixed(1)) : 0;
  const completionRatePercent = totalApplications > 0 ? Number(((terminalCount / totalApplications) * 100).toFixed(1)) : 0;

  const failureReasons = Array.from(failureMap.values()).sort((a, b) => b.count - a.count);

  const partialData = {
    targetDate,
    runStartedAt,
    totalApplications,
    totalApplied,
    totalFailed,
    totalQueued,
    totalReadyForReview,
    successRatePercent,
    completionRatePercent,
    atsBreakdown,
    failureReasons,
  };

  const executiveSummary = generateExecutiveSummary(partialData);

  return {
    ...partialData,
    executiveSummary,
  };
}

export function generateExecutiveSummary(data: Omit<ExecutiveDailyReportData, 'executiveSummary'>): string {
  const {
    targetDate,
    totalApplications,
    totalApplied,
    totalFailed,
    totalQueued,
    totalReadyForReview,
    successRatePercent,
    completionRatePercent,
    atsBreakdown,
    failureReasons,
  } = data;

  if (totalApplications === 0) {
    return `No active applications were recorded for the latest ingest run on ${targetDate}.`;
  }

  const atsSummaries: string[] = [];
  if (atsBreakdown.greenhouse.total > 0) {
    const gh = atsBreakdown.greenhouse;
    atsSummaries.push(
      `Greenhouse: ${gh.total} total (${gh.applied} applied, ${gh.failed} failed, ${gh.queued} queued)`
    );
  }
  if (atsBreakdown.ashby.total > 0) {
    const as = atsBreakdown.ashby;
    atsSummaries.push(
      `Ashby: ${as.total} total (${as.applied} applied, ${as.failed} failed, ${as.queued} queued)`
    );
  }
  if (atsBreakdown.other.total > 0) {
    const ot = atsBreakdown.other;
    atsSummaries.push(`Other: ${ot.total} total (${ot.applied} applied, ${ot.failed} failed)`);
  }

  const topFailure = failureReasons.length > 0 ? failureReasons[0] : null;
  const blockerNote = topFailure
    ? `Primary blocker: "${topFailure.reason}" (${topFailure.count} failure${topFailure.count === 1 ? '' : 's'}).`
    : 'No submission failures encountered.';

  return [
    `Latest Ingest Run (${targetDate}): ${totalApplications} total applications processed with ${completionRatePercent}% overall completion.`,
    `Execution Outcome: ${totalApplied} applied, ${totalFailed} failed, resulting in a ${successRatePercent}% success rate across resolved submissions.`,
    `Current Backlog: ${totalQueued} applications currently queued for submission; ${totalReadyForReview} ready for manual review.`,
    `ATS Distribution: ${atsSummaries.join(' | ') || 'None'}.`,
    blockerNote,
  ].join('\n');
}

const PAGE_SIZE = 1000;

export async function fetchLatestIngestRunReportData(
  supabaseClient?: any,
  options?: { targetDate?: string }
): Promise<ExecutiveDailyReportData> {
  const targetDate = options?.targetDate || (await getLatestIngestRunDate());
  const { startIso, endIso } = getISTDateRangeUtc(targetDate);

  if (!isSupabaseConfigured() && !supabaseClient) {
    log.info('[Executive Report] Supabase not configured — returning empty run data');
    return aggregateIngestRunMetrics([], targetDate);
  }

  const db = supabaseClient || getDbClient();
  const allRows: Array<{ id: string; status: string; job_url?: string; error_message?: string | null }> = [];

  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = db
        .from('gh_candidate_applications')
        .select('id, status, job_url, error_message')
        .gte('created_at', startIso);

      if (endIso) {
        query = query.lte('created_at', endIso);
      }

      const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
      if (error) {
        log.warn(`[Executive Report Fetch] Query failed at offset ${from}: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < PAGE_SIZE) break;
    }
  } catch (err: any) {
    log.warn(`[Executive Report Fetch] Exception: ${err?.message || err}`);
  }

  return aggregateIngestRunMetrics(allRows, targetDate);
}
