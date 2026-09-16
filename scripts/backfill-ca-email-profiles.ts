/**
 * Backfill profiles.ca_email from CA work-history (profiles only).
 *
 * Usage: npx tsx scripts/backfill-ca-email-profiles.ts
 */

import dotenv from 'dotenv';
import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';
import {
  DEFAULT_WORK_HISTORY_FROM,
  DEFAULT_WORK_HISTORY_TO,
  fetchAllWorkHistoryRows,
} from './backfillWorkHistoryPaginated.js';

dotenv.config();

async function updateProfileCaEmail(applywizz_id: string, ca_email: string): Promise<boolean> {
  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('profiles')
    .update({ ca_email, updated_at: new Date().toISOString() })
    .eq('applywizz_id', applywizz_id)
    .select('applywizz_id')
    .maybeSingle();

  if (error) {
    console.warn(`[Backfill] ⚠️ ${applywizz_id} — ${error.message}`);
    return false;
  }
  return Boolean(data?.applywizz_id);
}

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.error('[Backfill] Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }

  console.log(
    `[Backfill] Fetching work history ${DEFAULT_WORK_HISTORY_FROM} → ${DEFAULT_WORK_HISTORY_TO}…`
  );
  const rows = await fetchAllWorkHistoryRows();
  console.log(`[Backfill] ${rows.length} unique applywizz_id rows from work history`);

  let updated = 0;
  let notFound = 0;

  for (const { applywizz_id, ca_email } of rows) {
    const ok = await updateProfileCaEmail(applywizz_id, ca_email);
    if (ok) {
      updated += 1;
      console.log(`[Backfill] ✅ ${applywizz_id} → ${ca_email}`);
    } else {
      notFound += 1;
    }
  }

  console.log(`[Backfill] ✅ Done — ${updated} profiles updated, ${notFound} not found in profiles`);
}

main().catch((err) => {
  console.error('[Backfill] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
