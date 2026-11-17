import { config } from '../config/env.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { getLatestIngestRunDate } from '../db/ingestRuns.js';
import { getISTDateRangeUtc } from '../server/dashboardDateRange.js';
import { isAshbyUrl, isGreenhouseUrl } from '../scanner/atsDetector.js';
import { normalizeFailureReason } from '../server/analysisStats.js';
import { sendEmail, isAzureEmailConfigured } from './azureEmail.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ExecutiveDailyReport');

const DASHBOARD_URL = config.DASHBOARD_URL || 'https://applywizz.ai/admin';

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

export function buildExecutiveDailyReportHtml(data: ExecutiveDailyReportData): string {
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
    executiveSummary,
  } = data;

  const summaryBullets = executiveSummary
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `<li style="margin-bottom: 6px;">${line}</li>`)
    .join('');

  const atsRows = [
    { name: 'Greenhouse', stats: atsBreakdown.greenhouse },
    { name: 'Ashby', stats: atsBreakdown.ashby },
    ...(atsBreakdown.other.total > 0 ? [{ name: 'Other / Custom', stats: atsBreakdown.other }] : []),
  ]
    .map(({ name, stats }) => {
      const term = stats.applied + stats.failed;
      const rate = term > 0 ? ((stats.applied / term) * 100).toFixed(1) : '0.0';
      return `
      <tr>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-weight: 600;">${name}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right;">${stats.total}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; color: #15803d; font-weight: 600;">${stats.applied}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; color: #b91c1c; font-weight: 600;">${stats.failed}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; color: #d97706;">${stats.queued}</td>
        <td style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 600;">${rate}%</td>
      </tr>`;
    })
    .join('');

  const totalFailuresCount = failureReasons.reduce((sum, f) => sum + f.count, 0);
  const failureRows = failureReasons.length > 0
    ? failureReasons
        .slice(0, 10)
        .map((f) => {
          const pct = totalFailuresCount > 0 ? ((f.count / totalFailuresCount) * 100).toFixed(1) : '0.0';
          return `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">
          <span style="display: inline-block; padding: 2px 6px; background: #fee2e2; color: #991b1b; border-radius: 4px; font-weight: 600; font-size: 11px;">${f.category}</span>
        </td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${f.reason}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-weight: 600; color: #b91c1c; font-size: 13px;">${f.count}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: right; font-size: 13px; color: #64748b;">${pct}%</td>
      </tr>`;
        })
        .join('')
    : `
      <tr>
        <td colspan="4" style="padding: 12px; text-align: center; color: #15803d; font-size: 13px;">
          🎉 No submission failures encountered during this run!
        </td>
      </tr>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daily Executive Operations Digest</title>
</head>
<body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a;">
  <div style="max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 24px;">
    
    <!-- Header -->
    <div style="border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 20px;">
      <h1 style="font-size: 20px; margin: 0 0 6px 0; color: #0f172a;">
        Daily Executive Operations Digest — 9:00 AM IST
      </h1>
      <p style="font-size: 13px; color: #64748b; margin: 0;">
        Latest Ingest Run Assessment • Date: <strong>${targetDate}</strong>
      </p>
    </div>

    <!-- Executive Summary Box -->
    <div style="background: #1e293b; color: #f8fafc; border-radius: 6px; padding: 16px 20px; margin-bottom: 24px;">
      <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 10px 0; color: #94a3b8;">
        Executive Summary
      </h3>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
        ${summaryBullets}
      </ul>
    </div>

    <!-- KPI Summary Cards Table -->
    <table style="width: 100%; border-collapse: separate; border-spacing: 8px; margin-bottom: 24px;">
      <tr>
        <td style="background: #f1f5f9; padding: 14px; border-radius: 6px; text-align: center; width: 25%;">
          <div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600;">Total Ingested</div>
          <div style="font-size: 22px; font-weight: bold; color: #0f172a; margin-top: 4px;">${totalApplications}</div>
        </td>
        <td style="background: #ecfdf5; padding: 14px; border-radius: 6px; text-align: center; width: 25%;">
          <div style="font-size: 11px; text-transform: uppercase; color: #047857; font-weight: 600;">Applied</div>
          <div style="font-size: 22px; font-weight: bold; color: #15803d; margin-top: 4px;">${totalApplied}</div>
        </td>
        <td style="background: #fef2f2; padding: 14px; border-radius: 6px; text-align: center; width: 25%;">
          <div style="font-size: 11px; text-transform: uppercase; color: #b91c1c; font-weight: 600;">Failed</div>
          <div style="font-size: 22px; font-weight: bold; color: #b91c1c; margin-top: 4px;">${totalFailed}</div>
        </td>
        <td style="background: #fffbeb; padding: 14px; border-radius: 6px; text-align: center; width: 25%;">
          <div style="font-size: 11px; text-transform: uppercase; color: #b45309; font-weight: 600;">Queued</div>
          <div style="font-size: 22px; font-weight: bold; color: #d97706; margin-top: 4px;">${totalQueued}</div>
        </td>
      </tr>
      <tr>
        <td colspan="2" style="background: #eff6ff; padding: 12px 16px; border-radius: 6px; text-align: center;">
          <span style="font-size: 12px; color: #1e40af; font-weight: 600;">Success Rate: </span>
          <span style="font-size: 18px; font-weight: bold; color: #1d4ed8;">${successRatePercent}%</span>
        </td>
        <td colspan="2" style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px 16px; border-radius: 6px; text-align: center;">
          <span style="font-size: 12px; color: #475569; font-weight: 600;">Completion Rate: </span>
          <span style="font-size: 18px; font-weight: bold; color: #334155;">${completionRatePercent}%</span>
        </td>
      </tr>
    </table>

    <!-- ATS Breakdown Section -->
    <h3 style="font-size: 15px; margin: 20px 0 10px 0; color: #0f172a;">Performance by ATS Platform</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px;">
      <thead>
        <tr style="background: #f8fafc; text-align: left; color: #475569; font-size: 12px; text-transform: uppercase;">
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1;">Platform</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right;">Total</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right;">Applied</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right;">Failed</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right;">Queued</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right;">Success %</th>
        </tr>
      </thead>
      <tbody>
        ${atsRows}
      </tbody>
    </table>

    <!-- Top Failure Reasons Section -->
    <h3 style="font-size: 15px; margin: 20px 0 10px 0; color: #0f172a;">Top Failure Reasons (Grouped)</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
      <thead>
        <tr style="background: #f8fafc; text-align: left; color: #475569; font-size: 12px; text-transform: uppercase;">
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; width: 22%;">Category</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1;">Normalized Reason</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right; width: 15%;">Failures</th>
          <th style="padding: 8px 12px; border-bottom: 2px solid #cbd5e1; text-align: right; width: 12%;">Share</th>
        </tr>
      </thead>
      <tbody>
        ${failureRows}
      </tbody>
    </table>

    <!-- Action Button -->
    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; text-align: center;">
      <a href="${DASHBOARD_URL}" style="display: inline-block; padding: 10px 22px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px;">
        Open ApplyWizz Dashboard →
      </a>
      <p style="font-size: 12px; color: #94a3b8; margin-top: 16px; margin-bottom: 0;">
        Automated Daily Report dispatched every day at 9:00 AM IST to Executive Leadership.
      </p>
    </div>

  </div>
</body>
</html>
`.trim();
}

export interface ExecutiveDailyReportOptions {
  targetDate?: string;
  sendEmailFn?: (options: any) => Promise<any>;
  supabaseClient?: any;
}

export async function sendExecutiveDailyDigest(
  options: ExecutiveDailyReportOptions = {}
): Promise<{ success: boolean; data?: ExecutiveDailyReportData; error?: string }> {
  const sendEmailImpl = options.sendEmailFn || sendEmail;

  if (!isAzureEmailConfigured() && !options.sendEmailFn) {
    log.warn('[Executive Report] Azure email not configured — skipping daily digest send');
    return { success: false, error: 'Azure email service not configured' };
  }

  try {
    const data = await fetchLatestIngestRunReportData(options.supabaseClient, {
      targetDate: options.targetDate,
    });

    const recipients = resolveExecutiveDailyReportRecipients();
    const subject = `ApplyWizz Executive Daily Report — ${data.targetDate} (${data.totalApplied} applied, ${data.totalFailed} failed)`;

    await sendEmailImpl({
      to: recipients.to,
      cc: recipients.cc,
      subject,
      html: buildExecutiveDailyReportHtml(data),
      text: data.executiveSummary,
    });

    log.info(
      `[Executive Report] Dispatched daily digest to ${recipients.to.join(', ')} (apps=${data.totalApplications}, applied=${data.totalApplied}, failed=${data.totalFailed})`
    );

    return { success: true, data };
  } catch (err: any) {
    const msg = err?.message || String(err);
    log.error(`[Executive Report] Failed to dispatch daily digest: ${msg}`);
    return { success: false, error: msg };
  }
}
