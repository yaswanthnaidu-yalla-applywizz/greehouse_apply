/**
 * @fileoverview Tier 4 Answer Resolution: Live ApplyWizz API Refetch & Sync.
 * Source Tag: 'api', resolvedByTier: 4
 */

import { ApplyWizzClient } from '../candidate/applywizzClient.js';
import { upsertProfile, type ProfileRow } from '../db/profiles.js';
import { resolveTier1 } from './tier1Supabase.js';
import type { ResolvedField, ScannedField } from '../types/index.js';

let clientInstance: ApplyWizzClient | null = null;

function getApplywizzClient(): ApplyWizzClient {
  if (!clientInstance) {
    clientInstance = new ApplyWizzClient();
  }
  return clientInstance;
}

/**
 * Attempts Tier 4 resolution by refetching the candidate profile from the ApplyWizz API,
 * upserting the updated record to Supabase `profiles`, and re-evaluating Tier 1 logic.
 *
 * @returns ResolvedField with source: 'api', resolvedByTier: 4, or null if miss.
 */
export async function resolveTier4(
  applywizzId: string,
  field: ScannedField
): Promise<ResolvedField | null> {
  try {
    const client = getApplywizzClient();
    console.log(`[Tier 4] 🌐 Triggering live ApplyWizz API refetch for ${applywizzId}...`);

    // Force live refetch from remote API
    const fetched = await client.fetchCandidateProfile(applywizzId, true);
    if (!fetched) {
      return null;
    }

    // Upsert refreshed profile into Supabase
    const profilePayload: Partial<ProfileRow> & { applywizz_id: string; client_name: string } = {
      applywizz_id: fetched.applywizzId,
      client_name: fetched.clientName || fetched.applywizzId,
      first_name: fetched.firstName || null,
      last_name: fetched.lastName || null,
      email: fetched.email || null,
      phone: fetched.phone || null,
      location: fetched.location || null,
      linkedin_url: fetched.linkedinUrl || null,
      website_url: fetched.websiteUrl || null,
      github_url: fetched.githubUrl || null,
      work_authorization: fetched.workAuthorization || null,
      requires_sponsorship: Boolean(fetched.requiresSponsorship),
      education: fetched.education || [],
      work_experience: fetched.workExperience || [],
      resume_url: fetched.resumeUrl || null,
      raw_api_payload: fetched.demographics ? { demographics: fetched.demographics } : null,
      last_api_fetch_at: new Date().toISOString(),
    };

    const updatedProfile = await upsertProfile(profilePayload);

    // Re-run Tier 1 resolution logic with refreshed profile
    const tier1Result = await resolveTier1(applywizzId, field, updatedProfile);
    if (tier1Result) {
      return {
        ...tier1Result,
        source: 'api',
        resolvedByTier: 4,
        confidence: 1.0,
      };
    }
  } catch (err: any) {
    console.warn(`[Tier 4] API refetch error for ${applywizzId}: ${err.message}`);
  }

  return null;
}

export default resolveTier4;
