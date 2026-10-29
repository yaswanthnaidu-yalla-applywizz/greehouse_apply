/**
 * Zoho Mail connector eligibility — source of truth: `profiles.zoho_connected` in Supabase.
 */

import { getDbClient, isSupabaseConfigured } from './client.js';
import { getProfile, type ProfileRow } from './profiles.js';
import { createLogger } from '../utils/logger.js';
import { OperatorErrors } from '../operator/operatorErrorMessages.js';

const log = createLogger('Zoho Connected');

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
      log.warn(`[Zoho Connected] ⚠️ Could not load connected profiles: ${error.message}`);
      return new Set();
    }

    return new Set((data || []).map((row) => String(row.applywizz_id).trim().toUpperCase()));
  } catch (err: any) {
    log.warn(`[Zoho Connected] ⚠️ fetchZohoConnectedApplywizzIdSet failed: ${err.message}`);
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
    return { allowed: false, error: OperatorErrors.PROFILE_NOT_RETRIEVED };
  }

  if (!isProfileZohoConnected(profile)) {
    const { emitFailureDiagnostic } = await import('../utils/failureDiagnostics.js');
    await emitFailureDiagnostic({
      category: 'SYNC_ZOHO_CHECK',
      stage: 'zoho_verification',
      reason: OperatorErrors.ZOHO_NOT_CONNECTED,
      applywizzId: id,
      isTerminal: false,
      isRetryable: true,
    }).catch(() => {});
    return {
      allowed: false,
      error: OperatorErrors.ZOHO_NOT_CONNECTED,
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

/**
 * Checks whether an email address is an unmonitored consumer Gmail domain.
 */
export function isCandidateGmailEmail(email?: string | null): boolean {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim().toLowerCase();
  return clean.endsWith('@gmail.com') || clean.endsWith('@googlemail.com');
}

/**
 * Ingestion gate check:
 * When REQUIRE_ZOHO_CONNECTED is true, candidate must have zoho_connected === true
 * and candidate cannot have a consumer Gmail address.
 */
export function isCandidateEligibleForZohoGate(
  profile: ProfileRow | null | undefined
): { eligible: boolean; reason?: string } {
  if (!profile) {
    return { eligible: false, reason: 'missing_profile' };
  }
  if (profile.zoho_connected !== true) {
    return { eligible: false, reason: 'zoho_not_connected' };
  }
  if (isCandidateGmailEmail(profile.email) || isCandidateGmailEmail(profile.company_email)) {
    return { eligible: false, reason: 'gmail_email_not_served' };
  }
  return { eligible: true };
}
