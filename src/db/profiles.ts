/**
 * @fileoverview Database operations for candidate master profiles (V2).
 * Table: `profiles`
 */

import { getDbClient } from './client.js';

export interface ProfileRow {
  id?: string;
  applywizz_id: string;
  client_name: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  linkedin_url?: string | null;
  website_url?: string | null;
  github_url?: string | null;
  work_authorization?: string | null;
  requires_sponsorship?: boolean;
  education?: any[];
  work_experience?: any[];
  resume_storage_path?: string | null;
  resume_url?: string | null;
  raw_api_payload?: Record<string, any> | null;
  last_api_fetch_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Upserts a candidate profile record into Supabase.
 * Uses applywizz_id as the unique conflict target.
 */
export async function upsertProfile(
  profile: Partial<ProfileRow> & { applywizz_id: string; client_name: string }
): Promise<ProfileRow> {
  const supabase = getDbClient();
  const payload = {
    ...profile,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('profiles')
    .upsert(payload, { onConflict: 'applywizz_id' })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to upsert candidate profile for ${profile.applywizz_id}: ${error.message}`);
  }

  return data as ProfileRow;
}

/**
 * Fetches a candidate profile by ApplyWizz ID.
 */
export async function getProfile(applywizzId: string): Promise<ProfileRow | null> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('applywizz_id', applywizzId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get candidate profile for ${applywizzId}: ${error.message}`);
  }

  return data as ProfileRow | null;
}

/**
 * Fetches a candidate profile by resume URL or other remote URL reference.
 */
export async function getProfileByUrl(url: string): Promise<ProfileRow | null> {
  const supabase = getDbClient();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .or(`resume_url.eq.${url},linkedin_url.eq.${url},website_url.eq.${url}`)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get candidate profile by URL (${url}): ${error.message}`);
  }

  return data as ProfileRow | null;
}

/**
 * Updates the Supabase Storage resume path for a candidate.
 */
export async function updateResumeStoragePath(
  applywizzId: string,
  storagePath: string
): Promise<void> {
  const supabase = getDbClient();

  const { error } = await supabase
    .from('profiles')
    .update({
      resume_storage_path: storagePath,
      updated_at: new Date().toISOString(),
    })
    .eq('applywizz_id', applywizzId);

  if (error) {
    throw new Error(`Failed to update resume storage path for ${applywizzId}: ${error.message}`);
  }
}
