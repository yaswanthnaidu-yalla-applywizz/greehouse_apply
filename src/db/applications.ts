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
  resolvedFields: any[]
): Promise<void> {
  const updatePayload = {
    resolved_fields: resolvedFields,
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
  extra?: string | { proof_web_url?: string; proof_captured_at?: string; error_message?: string }
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
      if (isUuid) {
        await query.eq('id', id);
      } else {
        await query.eq('applywizz_id', id);
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
    if (app.id === id || app.applywizz_id === id) {
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
      let query = supabase.from('candidate_applications').select('*').order('created_at', { ascending: false });

      if (filter?.status) {
        query = query.eq('status', filter.status);
      }
      if (filter?.applywizzId) {
        query = query.eq('applywizz_id', filter.applywizzId);
      }

      const { data, error } = await query;
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

  return results;
}

