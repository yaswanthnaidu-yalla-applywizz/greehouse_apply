/**
 * @fileoverview Database operations for candidate job applications and status lifecycle (V2).
 * Table: `candidate_applications`
 */

import { getDbClient, isSupabaseConfigured } from './client.js';

export type ApplicationStatus =
  | 'READY_FOR_REVIEW'
  | 'DRY_RUN_COMPLETE'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CAPTCHA_REQUIRED';

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
  error_message?: string | null;
  dry_run_screenshot_url?: string | null;
  submitted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

const memoryApplications = new Map<string, ApplicationRow>();

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
 * Retrieves a candidate application by primary UUID.
 */
export async function getApplication(id: string): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('candidate_applications')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!error && data) {
        return data as ApplicationRow;
      }
    } catch (err: any) {
      // Fall through to memory
    }
  }

  return memoryApplications.get(id) || null;
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
 * Updates application lifecycle status.
 */
export async function updateStatus(
  id: string,
  status: ApplicationStatus,
  errorMessage?: string
): Promise<void> {
  const updatePayload: Partial<ApplicationRow> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (errorMessage !== undefined) {
    updatePayload.error_message = errorMessage;
  }
  if (status === 'APPLIED') {
    updatePayload.submitted_at = new Date().toISOString();
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
 * Sets the confirmation proof URL and capture timestamp for an application.
 */
export async function setProofUrl(
  id: string,
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

