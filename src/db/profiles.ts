/**
 * @fileoverview Database operations for candidate master profiles (V2).
 * Table: `profiles`
 */

import fs from 'fs';
import path from 'path';
import { getDbClient, isSupabaseConfigured } from './client.js';

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
 * Upserts a candidate profile record into Supabase or local cache.
 * Uses applywizz_id as the unique conflict target.
 */
export async function upsertProfile(
  profile: Partial<ProfileRow> & { applywizz_id: string; client_name: string }
): Promise<ProfileRow> {
  const payload = {
    ...profile,
    updated_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('profiles')
        .upsert(payload, { onConflict: 'applywizz_id' })
        .select()
        .single();

      if (!error && data) {
        return data as ProfileRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON Cache fallback
  try {
    const profilesDir = path.resolve(process.cwd(), 'cache', 'profiles');
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }
    const filePath = path.join(profilesDir, `${profile.applywizz_id}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          applywizzId: profile.applywizz_id,
          clientName: profile.client_name,
          firstName: profile.first_name,
          lastName: profile.last_name,
          email: profile.email,
          phone: profile.phone,
          location: profile.location,
          linkedinUrl: profile.linkedin_url,
          websiteUrl: profile.website_url,
          githubUrl: profile.github_url,
          workAuthorization: profile.work_authorization,
          requiresSponsorship: profile.requires_sponsorship,
          education: profile.education,
          workExperience: profile.work_experience,
          resumeUrl: profile.resume_url,
          localResumePath: profile.resume_storage_path,
          demographics: profile.raw_api_payload?.demographics,
        },
        null,
        2
      )
    );
  } catch {}

  return payload as ProfileRow;
}

/**
 * Fetches a candidate profile by ApplyWizz ID from Supabase or local cache.
 */
export async function getProfile(applywizzId: string): Promise<ProfileRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('applywizz_id', applywizzId)
        .maybeSingle();

      if (!error && data) {
        return data as ProfileRow;
      }
    } catch (err: any) {
      // Fall through to local fallback
    }
  }

  // Local JSON Cache fallback (cache/profiles/{applywizzId}.json)
  const localCachePath = path.resolve(process.cwd(), 'cache', 'profiles', `${applywizzId}.json`);
  if (fs.existsSync(localCachePath)) {
    try {
      const raw = fs.readFileSync(localCachePath, 'utf-8');
      const d = JSON.parse(raw);
      return {
        applywizz_id: d.applywizzId || applywizzId,
        client_name: d.clientName || applywizzId,
        first_name: d.firstName || null,
        last_name: d.lastName || null,
        email: d.email || null,
        phone: d.phone || null,
        location: d.location || null,
        linkedin_url: d.linkedinUrl || null,
        website_url: d.websiteUrl || null,
        github_url: d.githubUrl || null,
        work_authorization: d.workAuthorization || null,
        requires_sponsorship: Boolean(d.requiresSponsorship),
        education: d.education || [],
        work_experience: d.workExperience || [],
        resume_url: d.resumeUrl || null,
        resume_storage_path: d.localResumePath || null,
        raw_api_payload: d.demographics ? { demographics: d.demographics } : null,
      };
    } catch {}
  }

  return null;
}

/**
 * Fetches a candidate profile by resume URL or other remote URL reference.
 */
export async function getProfileByUrl(url: string): Promise<ProfileRow | null> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .or(`resume_url.eq.${url},linkedin_url.eq.${url},website_url.eq.${url}`)
        .maybeSingle();

      if (!error && data) {
        return data as ProfileRow;
      }
    } catch (err: any) {
      // Fall through
    }
  }

  return null;
}

/**
 * Updates the Supabase Storage resume path for a candidate.
 */
export async function updateResumeStoragePath(
  applywizzId: string,
  storagePath: string
): Promise<void> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('profiles')
        .update({
          resume_storage_path: storagePath,
          updated_at: new Date().toISOString(),
        })
        .eq('applywizz_id', applywizzId);
    } catch {}
  }
}

