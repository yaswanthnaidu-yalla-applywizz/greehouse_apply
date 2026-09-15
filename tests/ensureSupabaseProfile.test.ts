/**
 * Verifies pipeline profile creation: a missing Supabase profiles row is written
 * even when getProfile would return a local/demo hit.
 */

import { ensureSupabaseProfile } from '../src/candidate/ensureSupabaseProfile.js';
import type { ProfileRow } from '../src/db/profiles.js';
import type { ApplyWizzCandidateProfile } from '../src/types/index.js';

const MISSING_ID = 'AWL-39218';

function fakeApplyWizzProfile(id: string): ApplyWizzCandidateProfile {
  return {
    applywizzId: id,
    clientName: 'Fanatics Candidate',
    firstName: 'Test',
    lastName: 'User',
    email: 'test.user@applywizz.ai',
    phone: '555-0100',
    location: 'Dallas, TX',
    linkedinUrl: '',
    workAuthorization: 'H1B',
    requiresSponsorship: true,
    education: [],
    workExperience: [],
    resumeUrl: '',
    localResumePath: '',
  };
}

function fakeRow(id: string): ProfileRow {
  return {
    applywizz_id: id,
    client_name: 'Fanatics Candidate',
    zoho_connected: false,
  };
}

async function run(): Promise<void> {
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, name: string) {
    total++;
    if (condition) {
      console.log(`PASS: ${name}`);
      passed++;
    } else {
      console.error(`FAIL: ${name}`);
    }
  }

  // 1. Already in Supabase — do not fetch or upsert
  {
    let fetched = 0;
    let upserted = 0;
    const result = await ensureSupabaseProfile(
      MISSING_ID,
      {
        allowOutboundApi: true,
        downloadResumes: false,
        client: {
          isProfileCached: () => false,
          fetchCandidateProfileWithRaw: async () => {
            fetched++;
            return { profile: fakeApplyWizzProfile(MISSING_ID), raw: {} };
          },
          downloadResume: async () => '',
        },
      },
      {
        hasSupabaseProfile: async () => true,
        getProfile: async () => fakeRow(MISSING_ID),
        upsertProfile: async (row) => {
          upserted++;
          return row as ProfileRow;
        },
        updateResumeStoragePath: async () => undefined,
        uploadResume: async () => '',
      }
    );
    assert(result.status === 'exists', 'existing Supabase row is reused');
    assert(fetched === 0 && upserted === 0, 'existing row does not call ApplyWizz or upsert');
  }

  // 2. Missing in Supabase, pipeline allows API — must create
  {
    const store = new Set<string>();
    let upsertedId = '';
    const result = await ensureSupabaseProfile(
      MISSING_ID,
      {
        allowOutboundApi: true,
        downloadResumes: false,
        client: {
          isProfileCached: () => false,
          fetchCandidateProfileWithRaw: async (id) => ({
            profile: fakeApplyWizzProfile(id),
            raw: { source: 'api' },
          }),
          downloadResume: async () => '',
        },
      },
      {
        hasSupabaseProfile: async (id) => store.has(id),
        getProfile: async (id) => (store.has(id) ? fakeRow(id) : null),
        upsertProfile: async (row) => {
          upsertedId = row.applywizz_id;
          store.add(row.applywizz_id);
          return { ...fakeRow(row.applywizz_id), ...row };
        },
        updateResumeStoragePath: async () => undefined,
        uploadResume: async () => '',
      }
    );
    assert(result.status === 'created', 'missing row is created during pipeline');
    assert(upsertedId === MISSING_ID, 'upsert uses the CSV applywizz_id');
    assert(store.has(MISSING_ID), 'profiles store contains the new row after upsert');
    assert(result.profile?.applywizz_id === MISSING_ID, 'created result returns the new profile');
  }

  // 3. getProfile would return local cache, but Supabase has no row — still create
  {
    const store = new Set<string>();
    let upserted = 0;
    const result = await ensureSupabaseProfile(
      MISSING_ID,
      {
        allowOutboundApi: true,
        downloadResumes: false,
        client: {
          isProfileCached: () => true,
          fetchCandidateProfileWithRaw: async (id) => ({
            profile: fakeApplyWizzProfile(id),
            raw: {},
          }),
          downloadResume: async () => '',
        },
      },
      {
        hasSupabaseProfile: async (id) => store.has(id),
        getProfile: async () => fakeRow(MISSING_ID),
        upsertProfile: async (row) => {
          upserted++;
          store.add(row.applywizz_id);
          return { ...fakeRow(row.applywizz_id), ...row };
        },
        updateResumeStoragePath: async () => undefined,
        uploadResume: async () => '',
      }
    );
    assert(
      result.status === 'created' && upserted === 1,
      'local getProfile hit does not skip Supabase create'
    );
  }

  // 4. Missing and API blocked — do not create
  {
    let upserted = 0;
    const result = await ensureSupabaseProfile(
      MISSING_ID,
      {
        allowOutboundApi: false,
        downloadResumes: false,
        client: {
          isProfileCached: () => false,
          fetchCandidateProfileWithRaw: async () => {
            throw new Error('API should not be called');
          },
          downloadResume: async () => '',
        },
      },
      {
        hasSupabaseProfile: async () => false,
        getProfile: async () => null,
        upsertProfile: async (row) => {
          upserted++;
          return row as ProfileRow;
        },
        updateResumeStoragePath: async () => undefined,
        uploadResume: async () => '',
      }
    );
    assert(result.status === 'skipped' && upserted === 0, 'Rule 1 still blocks unapproved API');
  }

  // 5. Fetch succeeds but upsert does not land in Supabase — fail closed
  {
    const result = await ensureSupabaseProfile(
      MISSING_ID,
      {
        allowOutboundApi: true,
        downloadResumes: false,
        client: {
          isProfileCached: () => false,
          fetchCandidateProfileWithRaw: async (id) => ({
            profile: fakeApplyWizzProfile(id),
            raw: {},
          }),
          downloadResume: async () => '',
        },
      },
      {
        hasSupabaseProfile: async () => false,
        getProfile: async () => fakeRow(MISSING_ID),
        upsertProfile: async (row) => row as ProfileRow,
        updateResumeStoragePath: async () => undefined,
        uploadResume: async () => '',
      }
    );
    assert(result.status === 'failed', 'fail-closed when upsert does not persist to Supabase');
  }

  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
