import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSupabaseProfile } from '../src/candidate/ensureSupabaseProfile.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('freshResumeIngest - ensureSupabaseProfile forceRefreshResume', () => {
  it('downloads and uploads resume when forceRefreshResume is true even if profile exists', async () => {
    let downloadedId = '';
    let uploadedId = '';
    let updatedPathId = '';
    let updatedStoragePath = '';

    const existingProfile: ProfileRow = {
      applywizz_id: 'AWL-99999',
      client_name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe',
      resume_url: 'https://s3.example.com/resumes/jane.pdf',
      resume_storage_path: 'resumes/old_jane_resume.pdf',
    } as any;

    const mockClient = {
      isProfileCached: () => true,
      fetchCandidateProfileWithRaw: async () => ({
        profile: {
          applywizzId: 'AWL-99999',
          firstName: 'Jane',
          lastName: 'Doe',
          resumeUrl: 'https://s3.example.com/resumes/jane.pdf',
        } as any,
        raw: {},
      }),
      downloadResume: async (id: string, url: string) => {
        downloadedId = id;
        return 'test/path/AWL-99999_resume.pdf';
      },
    };

    const mockDeps = {
      hasSupabaseProfile: async () => true,
      getProfile: async () => existingProfile,
      upsertProfile: async () => existingProfile,
      uploadResume: async (id: string, buffer: Buffer, mime?: string, profile?: any) => {
        uploadedId = id;
        return `resumes/Resume_${profile?.firstName}_${profile?.lastName}.pdf`;
      },
      updateResumeStoragePath: async (id: string, storagePath: string) => {
        updatedPathId = id;
        updatedStoragePath = storagePath;
      },
    };

    // Override fs checks via global or test buffer
    const result = await ensureSupabaseProfile(
      'AWL-99999',
      {
        allowOutboundApi: true,
        downloadResumes: true,
        forceRefreshResume: true,
        client: mockClient as any,
      },
      mockDeps as any
    );

    assert.equal(result.status, 'exists');
    assert.equal(downloadedId, 'AWL-99999');
    assert.equal(uploadedId, 'AWL-99999');
    assert.equal(updatedPathId, 'AWL-99999');
    assert.equal(updatedStoragePath, 'resumes/Resume_Jane_Doe.pdf');
    assert.equal(result.profile?.resume_storage_path, 'resumes/Resume_Jane_Doe.pdf');
  });
});
