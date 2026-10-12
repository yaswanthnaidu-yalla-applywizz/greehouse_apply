/**
 * Ensures a CSV applywizz_id has a real Supabase `profiles` row.
 * Local cache / demo getProfile hits do not count — applications FK to profiles.
 */

import fs from 'fs';
import {
  getProfile,
  hasSupabaseProfile,
  upsertProfile,
  updateResumeStoragePath,
  type ProfileRow,
} from '../db/profiles.js';
import { uploadResume, type ResumeNamingProfile } from '../db/storage.js';
import type { ApplyWizzCandidateProfile } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { isPipelineCompactLogging } from '../utils/pipelineLogging.js';
import { emitFailureDiagnostic } from '../utils/failureDiagnostics.js';

const log = createLogger('Ensure Supabase Profile');

export type EnsureSupabaseProfileStatus = 'exists' | 'created' | 'skipped' | 'failed';

export interface EnsureSupabaseProfileResult {
  status: EnsureSupabaseProfileStatus;
  profile: ProfileRow | null;
  reason?: string;
}

export interface EnsureSupabaseProfileClient {
  isProfileCached(applywizzId: string): boolean;
  fetchCandidateProfileWithRaw(
    applywizzId: string,
    forceRefresh?: boolean
  ): Promise<{ profile: ApplyWizzCandidateProfile; raw: Record<string, any> }>;
  downloadResume(applywizzId: string, resumeUrl: string): Promise<string>;
}

export interface EnsureSupabaseProfileDeps {
  hasSupabaseProfile: (id: string) => Promise<boolean>;
  getProfile: (id: string) => Promise<ProfileRow | null>;
  upsertProfile: (row: Partial<ProfileRow> & { applywizz_id: string; client_name: string }) => Promise<ProfileRow>;
  updateResumeStoragePath: (id: string, path: string) => Promise<void>;
  uploadResume: (id: string, buffer: Buffer, mimeType?: string, profile?: ResumeNamingProfile) => Promise<string>;
}

const defaultDeps: EnsureSupabaseProfileDeps = {
  hasSupabaseProfile,
  getProfile,
  upsertProfile,
  updateResumeStoragePath,
  uploadResume,
};

export async function ensureSupabaseProfile(
  applywizzId: string,
  options: {
    allowOutboundApi: boolean;
    downloadResumes: boolean;
    client: EnsureSupabaseProfileClient;
  },
  deps: Partial<EnsureSupabaseProfileDeps> = {}
): Promise<EnsureSupabaseProfileResult> {
  const ports = { ...defaultDeps, ...deps };
  const id = (applywizzId || '').trim();
  if (!id) {
    return { status: 'skipped', profile: null, reason: 'empty applywizz_id' };
  }

  if (await ports.hasSupabaseProfile(id)) {
    const existing = await ports.getProfile(id);
    if (existing) {
      return { status: 'exists', profile: existing };
    }
  }

  const isCached = options.client.isProfileCached(id);
  if (!isCached && !options.allowOutboundApi) {
    return {
      status: 'skipped',
      profile: null,
      reason: 'no profiles row; outbound API blocked',
    };
  }

  if (!isPipelineCompactLogging()) {
    log.info(`[Candidate Ingestion] ℹ️ Candidate ${id} has no profiles row — fetching ApplyWizz profile...`);
  }

  try {
    let profile: ApplyWizzCandidateProfile;
    let raw: Record<string, any>;
    try {
      const fetched = await options.client.fetchCandidateProfileWithRaw(id, false);
      profile = fetched.profile;
      raw = fetched.raw;
    } catch (fetchErr: any) {
      await emitFailureDiagnostic({
        category: 'SYNC_APPLYWIZZ_FETCH',
        stage: 'applywizz_fetch',
        reason: fetchErr?.message || 'ApplyWizz profile fetch failed',
        error: fetchErr,
        applywizzId: id,
        isTerminal: false,
        isRetryable: true,
      }).catch(() => {});
      return {
        status: 'failed',
        profile: null,
        reason: fetchErr?.message || 'ApplyWizz fetch failed',
      };
    }

    let resumeStoragePath: string | null = null;
    if (options.downloadResumes && profile.resumeUrl) {
      let localPath = '';
      try {
        localPath = await options.client.downloadResume(id, profile.resumeUrl);
      } catch (dlErr: any) {
        await emitFailureDiagnostic({
          category: 'SYNC_RESUME_DOWNLOAD',
          stage: 'resume_download',
          reason: dlErr?.message || 'Resume download failed',
          error: dlErr,
          applywizzId: id,
          isTerminal: false,
          isRetryable: true,
        }).catch(() => {});
      }

      if (localPath) {
        try {
          if (fs.existsSync(localPath) && fs.statSync(localPath).size > 100) {
            const buffer = await fs.promises.readFile(localPath);
            resumeStoragePath = await ports.uploadResume(id, buffer, 'application/pdf', {
              firstName: profile.firstName,
              lastName: profile.lastName,
              workExperience: profile.workExperience,
            });
          }
        } catch (uploadErr: any) {
          log.warn(
            `[Candidate Ingestion] ⚠️ Could not upload resume for ${id} to Supabase Storage: ${uploadErr.message}`
          );
          await emitFailureDiagnostic({
            category: 'SYNC_RESUME_UPLOAD',
            stage: 'resume_upload',
            reason: uploadErr?.message || 'Resume upload to Supabase Storage failed',
            error: uploadErr,
            applywizzId: id,
            isTerminal: false,
            isRetryable: true,
          }).catch(() => {});
        }
      }
    }

    try {
      await ports.upsertProfile({
        applywizz_id: id,
        client_name: profile.clientName || id,
        first_name: profile.firstName || null,
        last_name: profile.lastName || null,
        company_email: profile.email || null,
        email: profile.email || null,
        phone: profile.phone || null,
        country: profile.country || null,
        country_code: profile.countryCode || null,
        location: profile.location || null,
        linkedin_url: profile.linkedinUrl || null,
        website_url: profile.websiteUrl || null,
        github_url: profile.githubUrl || null,
        work_authorization: profile.workAuthorization || null,
        requires_sponsorship: Boolean(profile.requiresSponsorship),
        education: (profile.education || []) as ProfileRow['education'],
        work_experience: (profile.workExperience || []) as ProfileRow['work_experience'],
        resume_url: profile.resumeUrl || null,
        resume_storage_path: resumeStoragePath,
        raw_api_payload: {
          ...raw,
          demographics: profile.demographics || raw.demographics,
        },
        last_api_fetch_at: new Date().toISOString(),
      });

      if (resumeStoragePath) {
        await ports.updateResumeStoragePath(id, resumeStoragePath);
      }
    } catch (upsertErr: any) {
      await emitFailureDiagnostic({
        category: 'SYNC_PROFILE_PERSIST',
        stage: 'profile_persist',
        reason: upsertErr?.message || 'Candidate profile upsert failed',
        error: upsertErr,
        applywizzId: id,
        isTerminal: false,
        isRetryable: true,
      }).catch(() => {});
      return {
        status: 'failed',
        profile: null,
        reason: upsertErr?.message || 'Profile upsert failed',
      };
    }
  } catch (err: any) {
    await emitFailureDiagnostic({
      category: 'SYNC_PROFILE_PERSIST',
      stage: 'profile_sync',
      reason: err?.message || 'ApplyWizz fetch or profile upsert failed',
      error: err,
      applywizzId: id,
      isTerminal: false,
      isRetryable: true,
    }).catch(() => {});
    return {
      status: 'failed',
      profile: null,
      reason: err?.message || 'ApplyWizz fetch or profile upsert failed',
    };
  }

  if (!(await ports.hasSupabaseProfile(id))) {
    await emitFailureDiagnostic({
      category: 'SYNC_PROFILE_PERSIST',
      stage: 'profile_verification',
      reason: 'ApplyWizz profile was not written to Supabase profiles',
      applywizzId: id,
      isTerminal: false,
      isRetryable: true,
    }).catch(() => {});
    return {
      status: 'failed',
      profile: null,
      reason: 'ApplyWizz profile was not written to Supabase profiles',
    };
  }

  const created = await ports.getProfile(id);
  if (!created) {
    await emitFailureDiagnostic({
      category: 'SYNC_PROFILE_PERSIST',
      stage: 'profile_verification',
      reason: 'profiles row missing after upsert',
      applywizzId: id,
      isTerminal: false,
      isRetryable: true,
    }).catch(() => {});
    return {
      status: 'failed',
      profile: null,
      reason: 'profiles row missing after upsert',
    };
  }
  return { status: 'created', profile: created };
}
