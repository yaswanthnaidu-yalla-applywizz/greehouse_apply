/**
 * @fileoverview Database operations for candidate job applications and status lifecycle (V2).
 * Table: `candidate_applications`
 */

import { getDbClient } from './client.js';

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

/**
 * Upserts a candidate application record.
 * Keyed by unique constraint (applywizz_id, job_url).
 */
export async function upsertApplication(
  app: Partial<ApplicationRow> & { applywizz_id: string; job_url: string; resolved_fields: any[] }
): Promise<ApplicationRow> {
  const supabase = getDbClient();
  const payload = {
    status: 'READY_FOR_REVIEW' as ApplicationStatus,
    ...app,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('candidate_applications')
    .upsert(payload, { onConflict: 'applywizz_id,job_url' })
    .select()
    .single();

  if (error) {
    throw new Error(
      `Failed to upsert application for ${app.applywizz_id} [${app.job_url}]: ${error.message}`
    );
  }

  return data as ApplicationRow;
}

/**
 * Retrieves a candidate application by primary UUID.
 */
export async function getApplication(id: string): Promise<ApplicationRow | null> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('candidate_applications')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get application ${id}: ${error.message}`);
  }

  return data as ApplicationRow | null;
}

/**
 * Retrieves a candidate application by candidate ID and job URL.
 */
export async function getApplicationByCandidateAndJob(
  applywizzId: string,
  jobUrl: string
): Promise<ApplicationRow | null> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('candidate_applications')
    .select('*')
    .eq('applywizz_id', applywizzId)
    .eq('job_url', jobUrl)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to get application for candidate ${applywizzId} [${jobUrl}]: ${error.message}`
    );
  }

  return data as ApplicationRow | null;
}

/**
 * Updates application lifecycle status.
 */
export async function updateStatus(
  id: string,
  status: ApplicationStatus,
  errorMessage?: string
): Promise<void> {
  const supabase = getDbClient();
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

  const { error } = await supabase
    .from('candidate_applications')
    .update(updatePayload)
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to update status for application ${id} to ${status}: ${error.message}`);
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
  const supabase = getDbClient();

  const { error } = await supabase
    .from('candidate_applications')
    .update({
      proof_web_url: proofUrl,
      proof_captured_at: capturedAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to set proof URL for application ${id}: ${error.message}`);
  }
}

/**
 * Sets the dry-run screenshot URL for an application.
 */
export async function setDryRunScreenshotUrl(
  id: string,
  screenshotUrl: string
): Promise<void> {
  const supabase = getDbClient();

  const { error } = await supabase
    .from('candidate_applications')
    .update({
      dry_run_screenshot_url: screenshotUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to set dry-run screenshot URL for application ${id}: ${error.message}`);
  }
}

/**
 * Lists candidate applications with optional status and candidate filters.
 */
export async function listApplications(filter?: {
  status?: ApplicationStatus;
  applywizzId?: string;
}): Promise<ApplicationRow[]> {
  const supabase = getDbClient();
  let query = supabase.from('candidate_applications').select('*').order('created_at', { ascending: false });

  if (filter?.status) {
    query = query.eq('status', filter.status);
  }
  if (filter?.applywizzId) {
    query = query.eq('applywizz_id', filter.applywizzId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list applications: ${error.message}`);
  }

  return (data || []) as ApplicationRow[];
}
