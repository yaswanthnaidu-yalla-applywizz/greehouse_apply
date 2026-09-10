/**
 * @fileoverview Database operations for candidate job applications and status lifecycle (V2).
 * Table: `candidate_applications`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';

export type ApplicationStatus =
  | 'READY_FOR_REVIEW'
  | 'DRY_RUN_COMPLETE'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'EXPIRED'
  | 'OTP_REQUIRED'
  | 'CAPTCHA_TIMEOUT';

export interface ApplicationRow {
  id?: string;
  applywizz_id: string;
  template_id?: string | null;
  job_url: string;
  company_name?: string | null;
  job_title?: string | null;
  status: ApplicationStatus;
  resolved_fields: any[];
  proof_web_url?: string | null;
  proof_captured_at?: string | null;
  proof_email_url?: string | null;
  proof_email_captured_at?: string | null;
  error_message?: string | null;
  dry_run_screenshot_url?: string | null;
  has_manual_edits?: boolean;
  reviewed_at?: string | null;
  submitted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

const memoryApplications = new Map<string, ApplicationRow>();

/**
 * Caches an application record in local memory for dry-run/submit lookups.
 */
export function cacheApplicationLocally(app: ApplicationRow): ApplicationRow {
  const id =
    app.id ||
    `${app.applywizz_id}_${Buffer.from(app.job_url || '').toString('base64url').slice(0, 16)}`;
  const cached = { ...app, id };
  memoryApplications.set(id, cached);
  if (app.applywizz_id && app.applywizz_id !== id) {
    memoryApplications.set(app.applywizz_id, cached);
  }
  return cached;
}

/**
 * Upserts a candidate application record into Supabase or local memory.
 * Keyed by unique constraint (applywizz_id, job_url).
 */
export async function upsertApplication(
  app: Partial<ApplicationRow> & { applywizz_id: string; job_url: string; resolved_fields: any[] }
): Promise<ApplicationRow> {
  const payload: any = {
    status: (app.status || 'READY_FOR_REVIEW') as ApplicationStatus,
    ...app,
    updated_at: new Date().toISOString(),
  };

  // Only pass id to Supabase if it's already a valid UUID
  if (!payload.id) {
    delete payload.id;
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .upsert(payload, { onConflict: 'applywizz_id,job_url' })
        .select()
        .single();

      if (!error && data) {
        memoryApplications.set(data.id, data as ApplicationRow);
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  const fallbackId = app.id || `${app.applywizz_id}_${Buffer.from(app.job_url).toString('base64url').slice(0, 16)}`;
  payload.id = fallbackId;
  memoryApplications.set(fallbackId, payload);
  return payload as ApplicationRow;
}


/**
 * Retrieves a candidate application by primary UUID or candidate applywizz_id.
 */
export async function getApplication(id: string, jobUrl?: string): Promise<ApplicationRow | null> {
  const cleanId = (id || '').trim();
  if (!cleanId) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      if (isUuid) {
        const { data, error } = await supabase
          .from('candidate_applications')
          .select('*')
          .eq('id', cleanId)
          .maybeSingle();

        if (!error && data) {
          const mem = memoryApplications.get(cleanId);
          if (
            mem &&
            mem.updated_at &&
            data.updated_at &&
            new Date(mem.updated_at).getTime() > new Date(data.updated_at).getTime()
          ) {
            return { ...(data as ApplicationRow), ...mem };
          }
          return data as ApplicationRow;
        }
      }

      // Query by applywizz_id
      let query = supabase
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', cleanId);

      if (jobUrl) {
        query = query.eq('job_url', jobUrl);
      }

      const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        const mem = memoryApplications.get(data.id) || memoryApplications.get(cleanId);
        if (
          mem &&
          mem.updated_at &&
          data.updated_at &&
          new Date(mem.updated_at).getTime() > new Date(data.updated_at).getTime()
        ) {
          return { ...(data as ApplicationRow), ...mem };
        }
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  // Check memory
  const mem = memoryApplications.get(cleanId);
  if (mem) return mem;

  for (const app of memoryApplications.values()) {
    if (app.applywizz_id === cleanId && (!jobUrl || app.job_url === jobUrl)) {
      return app;
    }
  }

  // 3. Disk fallback (output/resolved_applications.json)
  try {
    const diskPath = path.resolve(process.cwd(), 'output', 'resolved_applications.json');
    if (fs.existsSync(diskPath)) {
      const raw = fs.readFileSync(diskPath, 'utf8');
      const apps = JSON.parse(raw);
      if (Array.isArray(apps)) {
        const found = apps.find((a: any) =>
          (a.applywizzId === cleanId || a.id === cleanId) && (!jobUrl || a.jobUrl === jobUrl)
        );
        if (found) {
          const fallbackId: string = found.id || `${found.applywizzId}_${Buffer.from(found.jobUrl || '').toString('base64url').slice(0, 16)}`;
          const converted: ApplicationRow = {
            id: fallbackId,
            applywizz_id: found.applywizzId,
            job_url: found.jobUrl,
            company_name: found.companyName || '',
            job_title: found.jobTitle || '',
            status: found.status || 'READY_FOR_REVIEW',
            resolved_fields: found.resolvedFields || [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          memoryApplications.set(fallbackId, converted);
          return converted;
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Retrieves a candidate application by candidate ID and job URL.
 */
export async function getApplicationByCandidateAndJob(
  applywizzId: string,
  jobUrl: string
): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .eq('job_url', jobUrl)
        .maybeSingle();

      if (!error && data) {
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  for (const app of memoryApplications.values()) {
    if (app.applywizz_id === applywizzId && (app.job_url === jobUrl || jobUrl.includes(app.job_url))) {
      return app;
    }
  }

  return null;
}

/**
 * Updates the resolved fields payload for an application.
 */
export async function updateResolvedFields(
  id: string,
  resolvedFields: any[],
  extra?: { has_manual_edits?: boolean; reviewed_at?: string | null }
): Promise<void> {
  const updatePayload: Record<string, any> = {
    resolved_fields: resolvedFields,
    updated_at: new Date().toISOString(),
  };

  if (extra?.has_manual_edits !== undefined) {
    updatePayload.has_manual_edits = extra.has_manual_edits;
  }
  if (extra?.reviewed_at !== undefined) {
    updatePayload.reviewed_at = extra.reviewed_at;
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('candidate_applications')
        .update(updatePayload)
        .eq('id', id);
      return;
    } catch (err: any) {
      // Fall through to memory
    }
  }

  const existing = memoryApplications.get(id);
  if (existing) {
    memoryApplications.set(id, { ...existing, ...updatePayload });
  }
}

/**
 * Updates application lifecycle status.
 */
export async function updateStatus(
  id: string,
  status: ApplicationStatus,
  extra?: string | { proof_web_url?: string; proof_captured_at?: string; error_message?: string; job_url?: string }
): Promise<void> {
  const updatePayload: Partial<ApplicationRow> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (typeof extra === 'string') {
    updatePayload.error_message = extra;
  } else if (extra && typeof extra === 'object') {
    if (extra.error_message !== undefined) updatePayload.error_message = extra.error_message;
    if (extra.proof_web_url !== undefined) updatePayload.proof_web_url = extra.proof_web_url;
    if (extra.proof_captured_at !== undefined) updatePayload.proof_captured_at = extra.proof_captured_at;
  }

  if (status === 'APPLIED') {
    updatePayload.submitted_at = new Date().toISOString();
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const query = supabase.from('candidate_applications').update(updatePayload);
      let updateRes;
      if (isUuid) {
        updateRes = await query.eq('id', id);
      } else if (extra && typeof extra === 'object' && extra.job_url) {
        updateRes = await query.eq('applywizz_id', id).eq('job_url', extra.job_url);
      } else {
        updateRes = await query.eq('applywizz_id', id);
      }
      if (updateRes?.error) {
        console.error(`[DB] updateStatus Supabase error (${id}, ${status}):`, updateRes.error.message);
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  const existing = memoryApplications.get(id);
  if (existing) {
    memoryApplications.set(id, { ...existing, ...updatePayload });
  }
  for (const [key, app] of memoryApplications.entries()) {
    const jobMatch = !(extra && typeof extra === 'object' && extra.job_url) || app.job_url === extra.job_url;
    if (app.id === id || (app.applywizz_id === id && jobMatch)) {
      memoryApplications.set(key, { ...app, ...updatePayload });
    }
  }
}

/**
 * Sets the confirmation proof URL and capture timestamp for an application by UUID.
 */
export async function setProofUrl(
  id: string,
  proofUrl: string,
  capturedAt?: string
): Promise<void> {
  await attachProofToApplication({ id }, proofUrl, capturedAt);
}

/**
 * Attaches a post-submission proof screenshot URL to an application record.
 * Resolves by UUID when available, otherwise by (applywizz_id, job_url).
 */
export async function attachProofToApplication(
  application: Partial<Pick<ApplicationRow, 'id' | 'applywizz_id' | 'job_url'>>,
  proofUrl: string,
  capturedAt?: string
): Promise<void> {
  const updatePayload = {
    proof_web_url: proofUrl,
    proof_captured_at: capturedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      if (application.id) {
        const { error } = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('id', application.id);
        if (!error) return;
      }

      if (application.applywizz_id && application.job_url) {
        const { error } = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', application.applywizz_id)
          .eq('job_url', application.job_url);
        if (!error) return;
      }
    } catch {}
  }

  const memoryKey =
    application.id ||
    (application.applywizz_id && application.job_url
      ? `${application.applywizz_id}_${Buffer.from(application.job_url).toString('base64url').slice(0, 16)}`
      : '');
  if (!memoryKey) return;

  const existing = memoryApplications.get(memoryKey);
  if (existing) {
    memoryApplications.set(memoryKey, { ...existing, ...updatePayload });
  }
}

/**
 * Attaches a post-submission confirmation email proof screenshot URL to an application record.
 */
export async function attachEmailProofToApplication(
  application: Partial<Pick<ApplicationRow, 'id' | 'applywizz_id' | 'job_url'>>,
  proofEmailUrl: string,
  capturedAt?: string
): Promise<void> {
  const updatePayload = {
    proof_email_url: proofEmailUrl,
    proof_email_captured_at: capturedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      if (application.id) {
        const { error } = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('id', application.id);
        if (!error) return;
      }

      if (application.applywizz_id && application.job_url) {
        const { error } = await supabase
          .from('candidate_applications')
          .update(updatePayload)
          .eq('applywizz_id', application.applywizz_id)
          .eq('job_url', application.job_url);
        if (!error) return;
      }
    } catch {}
  }

  const memoryKey =
    application.id ||
    (application.applywizz_id && application.job_url
      ? `${application.applywizz_id}_${Buffer.from(application.job_url).toString('base64url').slice(0, 16)}`
      : '');
  if (!memoryKey) return;

  const existing = memoryApplications.get(memoryKey);
  if (existing) {
    memoryApplications.set(memoryKey, { ...existing, ...updatePayload });
  }
}

/**
 * Sets the dry-run screenshot URL for an application.
 */
export async function setDryRunScreenshotUrl(
  id: string,
  screenshotUrl: string
): Promise<void> {
  const updatePayload = {
    dry_run_screenshot_url: screenshotUrl,
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('candidate_applications')
        .update(updatePayload)
        .eq('id', id);
      return;
    } catch (err: any) {
      // Fall through
    }
  }

  const existing = memoryApplications.get(id);
  if (existing) {
    memoryApplications.set(id, { ...existing, ...updatePayload });
  }
}

/**
 * Lists candidate applications with optional status and candidate filters.
 */
export async function listApplications(filter?: {
  status?: ApplicationStatus;
  applywizzId?: string;
}): Promise<ApplicationRow[]> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const buildQuery = () => {
        let q = supabase.from('candidate_applications').select('*');
        if (filter?.status) {
          q = q.eq('status', filter.status);
        }
        if (filter?.applywizzId) {
          q = q.eq('applywizz_id', filter.applywizzId);
        }
        return q;
      };

      // Try ordering by has_manual_edits and reviewed_at first
      let { data, error } = await buildQuery()
        .order('has_manual_edits', { ascending: true })
        .order('reviewed_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false });

      // If columns don't exist yet on remote schema, fall back to created_at
      if (error && (error.message?.includes('has_manual_edits') || error.code === '42703')) {
        const fallback = await buildQuery().order('created_at', { ascending: false });
        data = fallback.data;
        error = fallback.error;
      }

      if (!error && data) {
        return data as ApplicationRow[];
      }
    } catch (err: any) {
      // Fall through
    }
  }

  let results = Array.from(memoryApplications.values());
  if (filter?.status) {
    results = results.filter((a) => a.status === filter.status);
  }
  if (filter?.applywizzId) {
    results = results.filter((a) => a.applywizz_id === filter.applywizzId);
  }

  results.sort((a, b) => {
    const aEdited = a.has_manual_edits ? 1 : 0;
    const bEdited = b.has_manual_edits ? 1 : 0;
    if (aEdited !== bEdited) return aEdited - bEdited;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  return results;
}

export interface NotificationItem {
  id: string;
  applywizzId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  status: 'APPLIED' | 'FAILED';
  reason?: string | null;
  proofWebUrl?: string | null;
  timestamp: string;
}

/**
 * Fetches recent succeeded and failed applications for notifications.
 */
export async function getRecentNotifications(limit = 40): Promise<NotificationItem[]> {
  const notifications: NotificationItem[] = [];

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .select('id, applywizz_id, job_url, company_name, job_title, status, error_message, proof_web_url, updated_at, submitted_at')
        .in('status', ['APPLIED', 'FAILED'])
        .order('updated_at', { ascending: false })
        .limit(limit);

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          notifications.push({
            id: row.id || `notif-${row.applywizz_id}-${Buffer.from(row.job_url || '').toString('base64url').slice(0, 12)}`,
            applywizzId: row.applywizz_id,
            companyName: row.company_name || 'Greenhouse Company',
            jobTitle: row.job_title || 'Job Opening',
            jobUrl: row.job_url,
            status: row.status as 'APPLIED' | 'FAILED',
            reason: row.error_message || null,
            proofWebUrl: row.proof_web_url || null,
            timestamp: row.submitted_at || row.updated_at || new Date().toISOString(),
          });
        }
      }
    } catch (err: any) {
      console.warn(`[DB] getRecentNotifications Supabase warning: ${err.message}`);
    }
  }

  // Incorporate in-memory applications
  for (const app of memoryApplications.values()) {
    if (app.status === 'APPLIED' || app.status === 'FAILED') {
      const exists = notifications.some(
        (n) => n.applywizzId === app.applywizz_id && (n.jobUrl === app.job_url || n.id === app.id)
      );
      if (!exists) {
        notifications.push({
          id: app.id || `notif-${app.applywizz_id}-${Buffer.from(app.job_url || '').toString('base64url').slice(0, 12)}`,
          applywizzId: app.applywizz_id,
          companyName: app.company_name || 'Greenhouse Company',
          jobTitle: app.job_title || 'Job Opening',
          jobUrl: app.job_url,
          status: app.status as 'APPLIED' | 'FAILED',
          reason: app.error_message || null,
          proofWebUrl: app.proof_web_url || null,
          timestamp: app.submitted_at || app.updated_at || new Date().toISOString(),
        });
      }
    }
  }

  notifications.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return notifications.slice(0, limit);
}

