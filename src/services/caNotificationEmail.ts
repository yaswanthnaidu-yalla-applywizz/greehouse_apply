/**
 * Post-ingest CA notification: one HTML email per CA summarizing new
 * READY_FOR_REVIEW applications created during the current pipeline run.
 */

import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import config from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { isAzureEmailConfigured, sendEmail } from './azureEmail.js';

const log = createLogger('CA Notification');

const DASHBOARD_URL = 'https://gh.applywizz.ai';

export type CaNotificationSummary = {
  caEmail: string;
  clientCount: number;
  appCount: number;
};

export type CaNotificationSendResult = {
  summaries: CaNotificationSummary[];
  sent: number;
  skipped: number;
  failed: number;
};

export type ReviewAppRow = {
  id?: string;
  applywizz_id?: string | null;
  assigned_ca_email?: string | null;
  job_url?: string | null;
};

/**
 * Groups READY_FOR_REVIEW rows by assigned CA email.
 * Skips null/empty CA emails and optionally excludes specified application keys.
 */
export function groupReadyForReviewByCa(
  rows: ReviewAppRow[],
  options?: { excludeKeys?: Set<string> }
): CaNotificationSummary[] {
  const byCa = new Map<string, { clients: Set<string>; appCount: number }>();

  for (const row of rows) {
    if (options?.excludeKeys && options.excludeKeys.size > 0 && row.applywizz_id && row.job_url) {
      const normalizedKey = `${String(row.applywizz_id).trim().toUpperCase()}::${row.job_url}`;
      if (options.excludeKeys.has(normalizedKey)) {
        continue;
      }
    }

    const caEmail = String(row.assigned_ca_email || '')
      .trim()
      .toLowerCase();
    if (!caEmail) continue;

    const applywizzId = String(row.applywizz_id || '')
      .trim()
      .toUpperCase();
    let bucket = byCa.get(caEmail);
    if (!bucket) {
      bucket = { clients: new Set(), appCount: 0 };
      byCa.set(caEmail, bucket);
    }
    bucket.appCount += 1;
    if (applywizzId) bucket.clients.add(applywizzId);
  }

  return Array.from(byCa.entries())
    .map(([caEmail, bucket]) => ({
      caEmail,
      clientCount: bucket.clients.size,
      appCount: bucket.appCount,
    }))
    .sort((a, b) => a.caEmail.localeCompare(b.caEmail));
}

export function buildCaNotificationHtml(summary: CaNotificationSummary): string {
  const { appCount, clientCount } = summary;
  return `
<h2>Hi,</h2>
<p>
  You have <strong>${appCount} application(s)</strong> across
  <strong>${clientCount} client(s)</strong> that need your review.
  These applications have questions answered by AI or left unresolved
  and require operator approval before submission.
</p>
<p>
  <a href="${DASHBOARD_URL}">Open ApplyWizz Dashboard →</a>
</p>
<p style="color:#888;font-size:12px;">
  This is an automated message from ApplyWizz. Do not reply.
</p>
`.trim();
}

const DEV_EMAIL = 'yaswanthnaiduyalla@applywizz.ai';
const PROD_LEADERSHIP_TO = ['ramakrishnaa.tejavath@applywizz.ai', 'balaji@applywizz.ai'];
const PROD_LEADERSHIP_CC = [
  'anushabandreddy@applywizz.ai',
  'vivek@applywizz.ai',
  'yaswanthnaiduyalla@applywizz.ai',
];

export function resolveLeadershipRecipients(): { to: string[]; cc: string[] } {
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
    to: [...PROD_LEADERSHIP_TO],
    cc: [...PROD_LEADERSHIP_CC],
  };
}

export interface LeadershipInitialSummary {
  totalTasks: number;
  clientCount: number;
  caCount: number;
  perCa: Array<{ caEmail: string; appCount: number; clientCount: number }>;
}

export function buildLeadershipInitialEmailHtml(summary: LeadershipInitialSummary): string {
  const { totalTasks, clientCount, caCount, perCa } = summary;
  const rowsHtml = perCa
    .map(
      (ca) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${ca.caEmail}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;"><strong>${ca.appCount}</strong></td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">${ca.clientCount}</td>
    </tr>`
    )
    .join('');

  return `
<h2>Ingestion Review Summary</h2>
<p style="font-size: 16px;">
  <strong>${totalTasks} tasks for ${clientCount} clients across ${caCount} CAs are ready for review.</strong>
</p>
<table style="width: 100%; max-width: 600px; border-collapse: collapse; margin: 16px 0; font-family: sans-serif; font-size: 14px;">
  <thead>
    <tr style="background: #f7f7f7; text-align: left;">
      <th style="padding: 8px 12px; border-bottom: 2px solid #ddd;">Career Associate</th>
      <th style="padding: 8px 12px; border-bottom: 2px solid #ddd; text-align: right;">Tasks Assigned</th>
      <th style="padding: 8px 12px; border-bottom: 2px solid #ddd; text-align: right;">Clients</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml}
  </tbody>
</table>
<p>
  <a href="${DASHBOARD_URL}" style="display: inline-block; padding: 10px 18px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold;">Open ApplyWizz Dashboard →</a>
</p>
<p style="color:#888;font-size:12px; margin-top: 24px;">
  This is an automated notification from ApplyWizz. Follow-up status check scheduled in 1.5 hours.
</p>
`.trim();
}

export interface CaRemainingTaskSummary {
  caEmail: string;
  remainingCount: number;
}

export function buildLeadershipReminderEmailHtml(remainingPerCa: CaRemainingTaskSummary[]): string {
  const totalRemaining = remainingPerCa.reduce((sum, item) => sum + item.remainingCount, 0);
  const rowsHtml = remainingPerCa
    .map(
      (ca) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${ca.caEmail}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right; color: #b91c1c;"><strong>${ca.remainingCount}</strong></td>
    </tr>`
    )
    .join('');

  return `
<h2>Review SLA Reminder — Pending Tasks</h2>
<p style="font-size: 16px;">
  1.5 hours have elapsed since ingestion. There are <strong>${totalRemaining} tasks remaining for review</strong> across <strong>${remainingPerCa.length} CA(s)</strong>.
</p>
<table style="width: 100%; max-width: 500px; border-collapse: collapse; margin: 16px 0; font-family: sans-serif; font-size: 14px;">
  <thead>
    <tr style="background: #f7f7f7; text-align: left;">
      <th style="padding: 8px 12px; border-bottom: 2px solid #ddd;">Career Associate</th>
      <th style="padding: 8px 12px; border-bottom: 2px solid #ddd; text-align: right;">Remaining Tasks</th>
    </tr>
  </thead>
  <tbody>
    ${rowsHtml}
  </tbody>
</table>
<p>
  <a href="${DASHBOARD_URL}" style="display: inline-block; padding: 10px 18px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold;">Review Pending Applications →</a>
</p>
<p style="color:#888;font-size:12px; margin-top: 24px;">
  Automated reminder from ApplyWizz.
</p>
`.trim();
}

export function buildLeadershipCompletionEmailHtml(): string {
  return `
<h2 style="color: #15803d;">🎉 ALL TASKS COMPLETED</h2>
<p style="font-size: 16px;">
  All tasks from today have been reviewed and completed across all Career Associates!
</p>
<p style="color: #4b5563;">
  Great job to the team. Zero applications remain pending for review.
</p>
<p>
  <a href="${DASHBOARD_URL}" style="display: inline-block; padding: 10px 18px; background-color: #16a34a; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold;">View ApplyWizz Dashboard →</a>
</p>
<p style="color:#888;font-size:12px; margin-top: 24px;">
  Automated completion notification from ApplyWizz.
</p>
`.trim();
}

export interface FollowupPollOptions {
  initialDelayMs?: number;
  pollIntervalMs?: number;
  dbQueryFn?: (appIds: string[]) => Promise<Array<{ id?: string; assigned_ca_email?: string | null }>>;
  sendEmailFn?: (options: any) => Promise<any>;
}

/**
 * Starts SLA follow-up polling on a specific set of application IDs.
 * First check runs at initialDelayMs (default 90m). Subsequent checks run every pollIntervalMs (default 60m).
 * Stops if:
 * 1. Remaining tasks reach 0 (sends completion email).
 * 2. Two consecutive checks show the same remaining count (stall detected).
 */
export function startLeadershipFollowupPoller(
  appIds: string[],
  options?: FollowupPollOptions
): { stop: () => void } {
  if (!appIds || appIds.length === 0) {
    return { stop: () => {} };
  }

  const initialDelay = options?.initialDelayMs ?? 90 * 60 * 1000;
  const pollInterval = options?.pollIntervalMs ?? 60 * 60 * 1000;
  const sendEmailImpl = options?.sendEmailFn ?? sendEmail;

  let activeTimer: NodeJS.Timeout | null = null;
  let isStopped = false;
  let lastRemainingCount: number | null = null;

  const defaultQueryFn = async (ids: string[]) => {
    if (!isSupabaseConfigured()) return [];
    const supabase = getDbClient();
    const { data, error } = await supabase
      .from('gh_candidate_applications')
      .select('id, assigned_ca_email')
      .in('id', ids)
      .eq('status', 'READY_FOR_REVIEW');
    if (error) {
      log.warn(`[Leadership Followup] Query failed: ${error.message}`);
      return [];
    }
    return (data || []) as Array<{ id?: string; assigned_ca_email?: string | null }>;
  };

  const queryFn = options?.dbQueryFn ?? defaultQueryFn;

  const runCheck = async (isFirstCheck: boolean) => {
    if (isStopped) return;
    try {
      const remainingRows = await queryFn(appIds);
      const remainingCount = remainingRows.length;
      log.info(`[Leadership Followup] Check (first=${isFirstCheck}): ${remainingCount} tasks remain of ${appIds.length}`);

      if (remainingCount === 0) {
        log.info('[Leadership Followup] All tasks completed! Dispatching congratulatory email.');
        const recipients = resolveLeadershipRecipients();
        await sendEmailImpl({
          to: recipients.to,
          cc: recipients.cc,
          subject: '🎉 ALL TASKS COMPLETED — ApplyWizz Review SLA',
          html: buildLeadershipCompletionEmailHtml(),
          text: 'All tasks from today have been reviewed and completed across all Career Associates!',
        });
        isStopped = true;
        return;
      }

      // If not first check, verify if progress stalled across two consecutive checks
      if (!isFirstCheck && lastRemainingCount !== null && remainingCount === lastRemainingCount) {
        log.info(`[Leadership Followup] Progress stalled (${remainingCount} === ${lastRemainingCount}). Stopping poller.`);
        isStopped = true;
        return;
      }

      lastRemainingCount = remainingCount;

      if (isFirstCheck) {
        const countsByCa = new Map<string, number>();
        for (const r of remainingRows) {
          const ca = String(r.assigned_ca_email || 'Unassigned').trim().toLowerCase();
          countsByCa.set(ca, (countsByCa.get(ca) || 0) + 1);
        }
        const remainingPerCa: CaRemainingTaskSummary[] = Array.from(countsByCa.entries())
          .map(([caEmail, count]) => ({ caEmail, remainingCount: count }))
          .sort((a, b) => b.remainingCount - a.remainingCount);

        const recipients = resolveLeadershipRecipients();
        await sendEmailImpl({
          to: recipients.to,
          cc: recipients.cc,
          subject: `Review SLA: ${remainingCount} tasks remaining for review — ApplyWizz`,
          html: buildLeadershipReminderEmailHtml(remainingPerCa),
          text: `1.5 hours have elapsed. ${remainingCount} tasks remain for review across ${remainingPerCa.length} CA(s).`,
        });
      }

      if (!isStopped) {
        activeTimer = setTimeout(() => {
          void runCheck(false);
        }, pollInterval);
        activeTimer.unref();
      }
    } catch (err: any) {
      log.warn(`[Leadership Followup] Check error: ${err?.message || err}`);
    }
  };

  activeTimer = setTimeout(() => {
    void runCheck(true);
  }, initialDelay);
  activeTimer.unref();

  return {
    stop: () => {
      isStopped = true;
      if (activeTimer) clearTimeout(activeTimer);
    },
  };
}

function resolveRecipient(caEmail: string): string {
  const override = String(config.CA_NOTIFICATION_EMAIL_OVERRIDE || '')
    .trim()
    .toLowerCase();
  return override || caEmail;
}

/**
 * After Phase D: email each CA with new READY_FOR_REVIEW apps created this run.
 * Failures are logged; this never throws to the pipeline.
 */
export async function sendCaNotificationEmails(
  runStartedAt: string | Date,
  options?: { excludeKeys?: Set<string> }
): Promise<CaNotificationSendResult> {
  const empty: CaNotificationSendResult = { summaries: [], sent: 0, skipped: 0, failed: 0 };
  const runStartedAtIso = runStartedAt instanceof Date ? runStartedAt.toISOString() : String(runStartedAt);

  if (!isSupabaseConfigured()) {
    log.info('[CA Notification] Supabase not configured — skipping CA emails');
    return empty;
  }

  if (!isAzureEmailConfigured()) {
    log.warn('[CA Notification] Azure email not configured — skipping CA emails');
    return empty;
  }

  let rows: ReviewAppRow[] = [];
  try {
    const supabase = getDbClient();
    const { data, error } = await supabase
      .from('gh_candidate_applications')
      .select('applywizz_id, assigned_ca_email, job_url')
      .eq('status', 'READY_FOR_REVIEW')
      .gte('created_at', runStartedAtIso);

    if (error) {
      log.warn(`[CA Notification] Query failed: ${error.message}`);
      return empty;
    }
    rows = (data || []) as ReviewAppRow[];
  } catch (err: any) {
    log.warn(`[CA Notification] Query exception: ${err?.message || err}`);
    return empty;
  }

  const summaries = groupReadyForReviewByCa(rows, options);
  if (summaries.length === 0) {
    log.info('[CA Notification] No READY_FOR_REVIEW apps with assigned CAs this run — skip');
    return empty;
  }

  let sent = 0;
  let failed = 0;
  const subject = 'You have new applications to review — ApplyWizz';

  for (const summary of summaries) {
    const to = resolveRecipient(summary.caEmail);
    try {
      const result = await sendEmail({
        to,
        subject,
        html: buildCaNotificationHtml(summary),
        text: `You have ${summary.appCount} application(s) across ${summary.clientCount} client(s) that need your review. Open ${DASHBOARD_URL}`,
      });
      if (result.success) {
        sent += 1;
        log.info(
          `[CA Notification] Sent to ${to}` +
            (to !== summary.caEmail ? ` (override for ${summary.caEmail})` : '') +
            ` apps=${summary.appCount} clients=${summary.clientCount}`
        );
      } else {
        failed += 1;
        log.warn(`[CA Notification] Failed for ${summary.caEmail}: ${result.error || 'unknown'}`);
      }
    } catch (err: any) {
      failed += 1;
      log.warn(`[CA Notification] Failed for ${summary.caEmail}: ${err?.message || err}`);
    }
  }

  return { summaries, sent, skipped: 0, failed };
}

/**
 * Dispatches an initial leadership email summarizing tasks ready for review across all CAs,
 * and launches the SLA follow-up poller for this run.
 */
export async function sendLeadershipIngestionSummary(
  runStartedAt: string | Date,
  options?: {
    excludeKeys?: Set<string>;
    followupOptions?: FollowupPollOptions;
  }
): Promise<void> {
  const runStartedAtIso = runStartedAt instanceof Date ? runStartedAt.toISOString() : String(runStartedAt);

  if (!isSupabaseConfigured()) {
    log.info('[Leadership Summary] Supabase not configured — skipping summary');
    return;
  }

  if (!isAzureEmailConfigured()) {
    log.warn('[Leadership Summary] Azure email not configured — skipping summary');
    return;
  }

  try {
    const supabase = getDbClient();
    const { data, error } = await supabase
      .from('gh_candidate_applications')
      .select('id, applywizz_id, assigned_ca_email, job_url')
      .eq('status', 'READY_FOR_REVIEW')
      .gte('created_at', runStartedAtIso);

    if (error) {
      log.warn(`[Leadership Summary] Query failed: ${error.message}`);
      return;
    }

    const rows = (data || []) as ReviewAppRow[];
    const filteredRows = rows.filter((r) => {
      if (options?.excludeKeys && options.excludeKeys.size > 0 && r.applywizz_id && r.job_url) {
        const key = `${String(r.applywizz_id).trim().toUpperCase()}::${r.job_url}`;
        if (options.excludeKeys.has(key)) return false;
      }
      return Boolean(r.assigned_ca_email);
    });

    if (filteredRows.length === 0) {
      log.info('[Leadership Summary] No new READY_FOR_REVIEW tasks with assigned CAs this run — skip summary');
      return;
    }

    const appIds = filteredRows.map((r) => r.id).filter((id): id is string => Boolean(id));
    const summaries = groupReadyForReviewByCa(filteredRows, options);
    const clientSet = new Set<string>();
    let totalTasks = 0;

    for (const r of filteredRows) {
      totalTasks++;
      if (r.applywizz_id) clientSet.add(r.applywizz_id.trim().toUpperCase());
    }

    const summaryData: LeadershipInitialSummary = {
      totalTasks,
      clientCount: clientSet.size,
      caCount: summaries.length,
      perCa: summaries,
    };

    const recipients = resolveLeadershipRecipients();
    const subject = `Review Queue: ${totalTasks} tasks for ${clientSet.size} clients across ${summaries.length} CAs ready for review`;

    await sendEmail({
      to: recipients.to,
      cc: recipients.cc,
      subject,
      html: buildLeadershipInitialEmailHtml(summaryData),
      text: `${totalTasks} tasks for ${clientSet.size} clients across ${summaries.length} CAs are ready for review.`,
    });

    log.info(`[Leadership Summary] Dispatched initial email to ${recipients.to.join(', ')} (tasks=${totalTasks})`);

    if (appIds.length > 0) {
      startLeadershipFollowupPoller(appIds, options?.followupOptions);
    }
  } catch (err: any) {
    log.warn(`[Leadership Summary] Failed to process leadership summary: ${err?.message || err}`);
  }
}
