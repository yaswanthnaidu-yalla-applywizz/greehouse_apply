/**
 * @fileoverview Notification state and queries for application submissions and failures.
 */

import fs from "fs";
import path from "path";
import { getDbClient, isSupabaseConfigured } from "../client.js";
import { createLogger } from "../../utils/logger.js";
import { memoryApplications } from "./memoryStore.js";
import { getISTDateRangeUtc, applyCreatedAtRangeFilter, rowCreatedAtInRange } from "./statsQueries.js";
import type { NotificationItem, CreatedAtRangeFilter } from "./types.js";

const log = createLogger("ApplicationsNotifications");


const dismissedNotificationIds = new Set<string>();

/**
 * Dismisses a notification by ID in-memory so it no longer appears in GET /api/notifications.
 */
export function dismissNotification(id: string): boolean {
  if (!id) return false;
  dismissedNotificationIds.add(id);
  return true;
}

/**
 * Dismisses all given notification IDs (or all current active) in-memory.
 */
export function dismissAllNotifications(ids?: string[]): void {
  if (ids && ids.length > 0) {
    for (const id of ids) dismissedNotificationIds.add(id);
  }
}

function resolveCandidateName(applywizzId: string): string {
  try {
    const profileFile = path.resolve(process.cwd(), 'cache', 'profiles', `${applywizzId}.json`);
    if (fs.existsSync(profileFile)) {
      const data = JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
      if (data.clientName || data.client_name) {
        return data.clientName || data.client_name;
      }
    }
  } catch {}
  return applywizzId;
}

/**
 * Fetches recent real application events (APPLYING, APPLIED, FAILED),
 * optionally filtered by IST calendar date and assigned candidate IDs.
 */
export async function getRecentNotifications(
  limit = 50,
  filter?: { date?: string; createdAtRange?: CreatedAtRangeFilter; allowedCandidateIds?: string[] }
): Promise<NotificationItem[]> {
  if (filter?.allowedCandidateIds !== undefined && filter.allowedCandidateIds.length === 0) {
    return [];
  }

  const notifications: NotificationItem[] = [];

  const allowedSet = filter?.allowedCandidateIds && filter.allowedCandidateIds.length > 0
    ? new Set(filter.allowedCandidateIds.map((id) => id.toUpperCase()))
    : null;

  const legacyDay =
    filter?.date && /^\d{4}-\d{2}-\d{2}$/.test(filter.date) ? getISTDateRangeUtc(filter.date) : null;
  const createdAtRange =
    filter?.createdAtRange ??
    (legacyDay ? { startIso: legacyDay.startIso, endIso: legacyDay.endIso } : null);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('gh_candidate_applications')
        .select('id, applywizz_id, job_url, company_name, job_title, status, error_message, proof_web_url, proof_failed_url, updated_at, submitted_at, created_at')
        .in('status', ['APPLYING', 'APPLIED', 'FAILED', 'RETRY'])
        .neq('applywizz_id', 'AWL-YASWANTH');

      if (allowedSet && filter?.allowedCandidateIds) {
        query = query.in('applywizz_id', filter.allowedCandidateIds);
      }

      if (createdAtRange) {
        query = applyCreatedAtRangeFilter(query, createdAtRange);
      }

      const { data, error } = await query
        .order('updated_at', { ascending: false })
        .limit(limit * 2);

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const id = row.id || `notif-${row.applywizz_id}-${Buffer.from(row.job_url || '').toString('base64url').slice(0, 16)}`;
          if (dismissedNotificationIds.has(id) || (row.id && dismissedNotificationIds.has(row.id))) {
            continue;
          }

          notifications.push({
            id,
            applywizzId: row.applywizz_id,
            candidateName: resolveCandidateName(row.applywizz_id),
            companyName: row.company_name || 'Greenhouse Company',
            jobTitle: row.job_title || 'Job Opening',
            jobUrl: row.job_url,
            status: row.status as 'APPLYING' | 'APPLIED' | 'FAILED' | 'RETRY',
            reason: row.error_message || null,
            proofWebUrl: row.proof_web_url || null,
            proofFailedUrl: row.proof_failed_url || null,
            timestamp: row.updated_at || row.submitted_at || new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      log.warn(`[DB] getRecentNotifications Supabase warning: ${err.message}`);
    }
  }

  // Incorporate in-memory applications
  for (const app of memoryApplications.values()) {
    if (
      (app.status === 'APPLYING' || app.status === 'APPLIED' || app.status === 'FAILED' || app.status === 'RETRY') &&
      app.applywizz_id !== 'AWL-YASWANTH'
    ) {
      if (allowedSet && !allowedSet.has(app.applywizz_id.toUpperCase())) {
        continue;
      }

      if (createdAtRange && !rowCreatedAtInRange(app, createdAtRange)) {
        continue;
      }

      const id = app.id || `notif-${app.applywizz_id}-${Buffer.from(app.job_url || '').toString('base64url').slice(0, 16)}`;
      if (dismissedNotificationIds.has(id) || (app.id && dismissedNotificationIds.has(app.id))) {
        continue;
      }

      const exists = notifications.some(
        (n) => n.id === id || (n.applywizzId === app.applywizz_id && n.jobUrl === app.job_url && n.status === app.status)
      );
      if (!exists) {
        notifications.push({
          id,
          applywizzId: app.applywizz_id,
          candidateName: resolveCandidateName(app.applywizz_id),
          companyName: app.company_name || 'Greenhouse Company',
          jobTitle: app.job_title || 'Job Opening',
          jobUrl: app.job_url,
          status: app.status as 'APPLYING' | 'APPLIED' | 'FAILED' | 'RETRY',
          reason: app.error_message || null,
          proofWebUrl: app.proof_web_url || null,
          proofFailedUrl: app.proof_failed_url || null,
          timestamp: app.updated_at || app.submitted_at || new Date().toISOString(),
        });
      }
    }
  }

  notifications.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return notifications.slice(0, limit);
}
