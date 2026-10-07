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

type ReviewAppRow = {
  applywizz_id?: string | null;
  assigned_ca_email?: string | null;
};

/**
 * Groups READY_FOR_REVIEW rows by assigned CA email.
 * Skips null/empty CA emails.
 */
export function groupReadyForReviewByCa(rows: ReviewAppRow[]): CaNotificationSummary[] {
  const byCa = new Map<string, { clients: Set<string>; appCount: number }>();

  for (const row of rows) {
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
export async function sendCaNotificationEmails(runStartedAt: string | Date): Promise<CaNotificationSendResult> {
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
      .select('applywizz_id, assigned_ca_email')
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

  const summaries = groupReadyForReviewByCa(rows);
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
