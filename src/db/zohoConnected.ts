/**
 * Zoho Mail connector eligibility — source of truth: `profiles.zoho_connected` in Supabase.
 */

import { getDbClient, isSupabaseConfigured } from './client.js';
import { getProfile, type ProfileRow } from './profiles.js';

export const ZOHO_DEMO_BYPASS_APPLYWIZZ_IDS = new Set(['AWL-YASWANTH', 'AWL-31428', 'AWL-YASHANTH']);

export function isProfileZohoConnected(profile: ProfileRow | null | undefined): boolean {
  return Boolean(profile?.zoho_connected);
}

export function isZohoDemoBypassApplywizzId(applywizzId: string, isAdmin: boolean): boolean {
  if (!isAdmin) return false;
  return ZOHO_DEMO_BYPASS_APPLYWIZZ_IDS.has(applywizzId.trim().toUpperCase());
}

/**
 * Returns applywizz IDs from the input list that have `profiles.zoho_connected = true`.
 */
export async function fetchZohoConnectedApplywizzIdSet(applywizzIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(applywizzIds.map((id) => id.trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0) {
    return new Set();
  }

  if (!isSupabaseConfigured()) {
    return new Set();
  }

  try {
    const supabase = getDbClient();
    const { data, error } = await supabase
      .from('profiles')
      .select('applywizz_id')
      .eq('zoho_connected', true)
      .in('applywizz_id', unique);

    if (error) {
      console.warn(`[Zoho Connected] ⚠️ Could not load connected profiles: ${error.message}`);
      return new Set();
    }

    return new Set((data || []).map((row) => String(row.applywizz_id).trim().toUpperCase()));
  } catch (err: any) {
    console.warn(`[Zoho Connected] ⚠️ fetchZohoConnectedApplywizzIdSet failed: ${err.message}`);
    return new Set();
  }
}

export async function assertApplywizzZohoConnected(
  applywizzId: string,
  options?: { isAdmin?: boolean; allowAdminDemo?: boolean }
): Promise<{ allowed: boolean; error?: string }> {
  const id = applywizzId.trim();
  if (!id) {
    return { allowed: false, error: 'Missing candidate ApplyWizz ID.' };
  }

  if (!isSupabaseConfigured()) {
    return { allowed: true };
  }

  if (options?.allowAdminDemo && isZohoDemoBypassApplywizzId(id, Boolean(options.isAdmin))) {
    return { allowed: true };
  }

  const profile = await getProfile(id);
  if (!profile) {
    return { allowed: false, error: `Candidate profile '${id}' was not found.` };
  }

  if (!isProfileZohoConnected(profile)) {
    return {
      allowed: false,
      error: `Candidate '${id}' is not Zoho Mail connected. Automation is disabled for this profile.`,
    };
  }

  return { allowed: true };
}

export async function resolveApplywizzIdFromApplicationRef(
  applicationId: string,
  jobUrl?: string
): Promise<string | null> {
  const { getApplication } = await import('./applications.js');
  const application = await getApplication(applicationId, jobUrl);
  if (application?.applywizz_id) {
    return application.applywizz_id;
  }

  const clean = applicationId.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);
  if (!isUuid) {
    return clean.includes('_') ? clean.split('_')[0] : clean;
  }

  return null;
}
