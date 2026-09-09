/**
 * @fileoverview One-time backfill of profiles.company_email from raw_api_payload or ApplyWizz API.
 *
 * Prerequisites — run in Supabase SQL Editor (or apply migrations/001_add_company_email.sql):
 *   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS company_email TEXT;
 *
 * Usage:
 *   npx tsx src/db/backfillCompanyEmail.ts                  # backfill from raw_api_payload only
 *   npx tsx src/db/backfillCompanyEmail.ts --fetch-missing  # also call ApplyWizz API for gaps
 *   npx tsx src/db/backfillCompanyEmail.ts --dry-run        # preview without writing
 *   npx tsx src/db/backfillCompanyEmail.ts --limit=10       # process first N candidates
 */

import { ApplyWizzClient } from '../candidate/applywizzClient.js';
import { getDbClient, isSupabaseConfigured } from './client.js';
import { extractCompanyEmailFromPayload, isCompanyEmailDomain } from './profiles.js';

export interface BackfillResult {
  total: number;
  alreadySet: number;
  fromPayload: number;
  fromApi: number;
  stillMissing: number;
  updated: number;
  dryRun: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(args: string[]) {
  return {
    dryRun: args.includes('--dry-run'),
    fetchMissing: args.includes('--fetch-missing'),
    limit: (() => {
      const arg = args.find((a) => a.startsWith('--limit='));
      return arg ? parseInt(arg.split('=')[1], 10) : undefined;
    })(),
  };
}

/**
 * Backfills company_email for all profiles missing it.
 */
export async function backfillCompanyEmail(options: {
  dryRun?: boolean;
  fetchMissing?: boolean;
  limit?: number;
} = {}): Promise<BackfillResult> {
  const { dryRun = false, fetchMissing = false, limit } = options;

  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabase = getDbClient();
  const client = new ApplyWizzClient();

  console.log('================================================================');
  console.log('  Company Email Backfill');
  console.log('================================================================');
  console.log(`• Dry run:       ${dryRun}`);
  console.log(`• Fetch missing: ${fetchMissing} (ApplyWizz API — one-time only)`);
  if (limit) console.log(`• Limit:         ${limit}`);
  console.log('');

  // Verify column exists
  const { error: probeError } = await supabase
    .from('profiles')
    .select('applywizz_id, company_email, email, raw_api_payload')
    .limit(1);

  if (probeError?.message?.includes('company_email')) {
    throw new Error(
      `Column profiles.company_email does not exist. Run src/db/migrations/001_add_company_email.sql in Supabase SQL Editor first.\n${probeError.message}`
    );
  }

  const { data: rows, error } = await supabase
    .from('profiles')
    .select('applywizz_id, client_name, company_email, email, raw_api_payload')
    .order('applywizz_id');

  if (error) {
    throw new Error(`Failed to load profiles: ${error.message}`);
  }

  const profiles = (rows || []).slice(0, limit ?? undefined);
  const result: BackfillResult = {
    total: profiles.length,
    alreadySet: 0,
    fromPayload: 0,
    fromApi: 0,
    stillMissing: 0,
    updated: 0,
    dryRun,
  };

  for (const row of profiles) {
    const id = row.applywizz_id;

    if (row.company_email && isCompanyEmailDomain(row.company_email)) {
      result.alreadySet++;
      continue;
    }

    let companyEmail = extractCompanyEmailFromPayload(row.raw_api_payload, row.email);
    let rawPayload = row.raw_api_payload;

    if (!companyEmail && fetchMissing) {
      try {
        console.log(`[Backfill] 🌐 Fetching ${id} from ApplyWizz API...`);
        const { profile, raw } = await client.fetchCandidateProfileWithRaw(id, true);
        companyEmail = extractCompanyEmailFromPayload(raw, profile.email);
        rawPayload = {
          ...(rawPayload || {}),
          ...raw,
          demographics: profile.demographics || raw?.demographics,
        };
        result.fromApi++;
        await sleep(300);
      } catch (err: any) {
        console.warn(`[Backfill] ⚠️ API fetch failed for ${id}: ${err.message}`);
      }
    } else if (companyEmail) {
      result.fromPayload++;
    }

    if (!companyEmail || !isCompanyEmailDomain(companyEmail)) {
      result.stillMissing++;
      console.warn(`[Backfill] ❌ No valid @applywizard.ai company email for ${id} (${row.client_name})`);
      if (!dryRun && row.company_email && !isCompanyEmailDomain(row.company_email)) {
        await supabase
          .from('profiles')
          .update({ company_email: null, updated_at: new Date().toISOString() })
          .eq('applywizz_id', id);
      }
      continue;
    }

    console.log(`[Backfill] ✅ ${id} → ${companyEmail}`);

    if (!dryRun) {
      const updatePayload: Record<string, unknown> = {
        company_email: companyEmail,
        email: companyEmail,
        raw_api_payload: rawPayload,
        updated_at: new Date().toISOString(),
      };
      if (fetchMissing && rawPayload !== row.raw_api_payload) {
        updatePayload.last_api_fetch_at = new Date().toISOString();
      }

      const { error: updateError } = await supabase
        .from('profiles')
        .update(updatePayload)
        .eq('applywizz_id', id);

      if (updateError) {
        console.warn(`[Backfill] ⚠️ Update failed for ${id}: ${updateError.message}`);
      } else {
        result.updated++;
      }
    } else {
      result.updated++;
    }
  }

  console.log('\n================================================================');
  console.log('  Backfill Summary');
  console.log('================================================================');
  console.log(`• Total profiles:    ${result.total}`);
  console.log(`• Already had email: ${result.alreadySet}`);
  console.log(`• From raw payload:  ${result.fromPayload}`);
  console.log(`• From ApplyWizz API:${result.fromApi}`);
  console.log(`• Updated:           ${result.updated}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`• Still missing:     ${result.stillMissing}`);
  console.log('================================================================');

  return result;
}

if (process.argv[1]?.includes('backfillCompanyEmail')) {
  const opts = parseArgs(process.argv.slice(2));
  backfillCompanyEmail(opts)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Backfill failed:', err.message);
      process.exit(1);
    });
}

export default backfillCompanyEmail;
