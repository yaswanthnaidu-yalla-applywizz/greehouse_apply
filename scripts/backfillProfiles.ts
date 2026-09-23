import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApplyWizzClient } from '../src/candidate/applywizzClient.js';
import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';
import { upsertProfile } from '../src/db/profiles.js';
import type { ApplyWizzCandidateProfile } from '../src/types/index.js';

const BATCH_SIZE = 10;
const PROFILE_PAGE_SIZE = 1000;

function toProfileRow(
  profile: ApplyWizzCandidateProfile,
  raw: Record<string, any>
): Parameters<typeof upsertProfile>[0] {
  return {
    applywizz_id: profile.applywizzId,
    client_name: profile.clientName || profile.applywizzId,
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
    education: profile.education || [],
    work_experience: profile.workExperience || [],
    resume_url: profile.resumeUrl || null,
    raw_api_payload: {
      ...raw,
      demographics: profile.demographics || raw.demographics,
    },
    last_api_fetch_at: new Date().toISOString(),
  };
}

async function fetchApplywizzIds(): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PROFILE_PAGE_SIZE) {
    const { data, error } = await getDbClient()
      .from('profiles')
      .select('applywizz_id')
      .range(from, from + PROFILE_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Failed to fetch profile IDs: ${error.message}`);
    }

    const page = (data || [])
      .map((row) => String((row as { applywizz_id?: unknown }).applywizz_id || '').trim())
      .filter(Boolean);
    ids.push(...page);
    if (page.length < PROFILE_PAGE_SIZE) break;
  }
  return [...new Set(ids)];
}

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const applywizzIds = await fetchApplywizzIds();
  console.log(`[Backfill] total=${applywizzIds.length}`);

  const client = new ApplyWizzClient();
  const failed: string[] = [];
  let succeeded = 0;
  let skipped = 0;
  let processed = 0;

  for (let start = 0; start < applywizzIds.length; start += BATCH_SIZE) {
    const batch = applywizzIds.slice(start, start + BATCH_SIZE);
    const outcomes = await Promise.all(
      batch.map(async (applywizzId) => {
        try {
          const { profile, raw } = await client.fetchCandidateProfileWithRaw(applywizzId, true);
          await upsertProfile(toProfileRow(profile, raw));
          return 'succeeded' as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Invalid response payload received/i.test(message)) {
            return 'skipped' as const;
          }
          failed.push(applywizzId);
          return 'failed' as const;
        }
      })
    );

    succeeded += outcomes.filter((outcome) => outcome === 'succeeded').length;
    skipped += outcomes.filter((outcome) => outcome === 'skipped').length;
    processed += batch.length;
    console.log(`[Backfill] progress ${processed}/${applywizzIds.length}...`);
  }

  const failedPath = path.resolve(process.cwd(), 'scripts', 'backfill_failed.json');
  await fs.writeFile(failedPath, `${JSON.stringify(failed, null, 2)}\n`, 'utf8');
  console.log(
    `[Backfill] done total=${applywizzIds.length} succeeded=${succeeded} failed=${failed.length} skipped=${skipped}`
  );
}

main().catch((error) => {
  console.error(`[Backfill] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
