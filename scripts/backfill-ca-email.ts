/**
 * Backfill profiles.ca_email, dashboard users (operators), and manager_email mapping
 * from CA work-history + get-client-details.
 *
 * Usage: npx tsx scripts/backfill-ca-email.ts
 */

import dotenv from 'dotenv';
import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';
import { getDashboardUserByEmail } from '../src/db/users.js';
import {
  managerEmailForCareerAssociateManagerId,
} from '../src/services/operatorManagerMapping.js';
import {
  DEFAULT_WORK_HISTORY_FROM,
  DEFAULT_WORK_HISTORY_TO,
  fetchAllWorkHistoryRows,
  sampleApplywizzIdByCaEmail,
} from './backfillWorkHistoryPaginated.js';

dotenv.config();

const CLIENT_DETAILS_BASE = 'https://www.apply-wizz.me/api/get-client-details';

async function updateProfileCaEmail(applywizz_id: string, ca_email: string): Promise<boolean> {
  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('profiles')
    .update({ ca_email, updated_at: new Date().toISOString() })
    .eq('applywizz_id', applywizz_id)
    .select('applywizz_id')
    .maybeSingle();

  if (error) {
    console.warn(`[Backfill] ⚠️ profile ${applywizz_id} — ${error.message}`);
    return false;
  }
  return Boolean(data?.applywizz_id);
}

async function upsertOperatorUser(ca_email: string): Promise<void> {
  const existing = await getDashboardUserByEmail(ca_email);
  const supabase = getDbClient();
  const row = {
    email: ca_email,
    role: 'operator',
    name: existing?.name ?? null,
    manager_email: existing?.manager_email ?? null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('users').upsert(row, { onConflict: 'email' });
  if (error) {
    console.warn(`[Backfill] ⚠️ users upsert ${ca_email} — ${error.message}`);
  }
}

async function fetchCareerAssociateManagerId(applywizz_id: string): Promise<string | null> {
  const url = `${CLIENT_DETAILS_BASE}?applywizz_id=${encodeURIComponent(applywizz_id)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    console.warn(`[Backfill] ⚠️ get-client-details ${applywizz_id} HTTP ${response.status}`);
    return null;
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object') return null;
  const client = (data as Record<string, unknown>).client;
  if (!client || typeof client !== 'object') return null;
  const id = (client as Record<string, unknown>).careerassociatemanagerid;
  return typeof id === 'string' && id.trim() ? id.trim().toLowerCase() : null;
}

async function setOperatorManagerEmail(ca_email: string, manager_email: string): Promise<void> {
  const supabase = getDbClient();
  const { error } = await supabase
    .from('users')
    .update({ manager_email, updated_at: new Date().toISOString() })
    .eq('email', ca_email);
  if (error) {
    console.warn(`[Backfill] ⚠️ manager_email ${ca_email} — ${error.message}`);
  }
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

  let profilesUpdated = 0;
  for (const { applywizz_id, ca_email } of rows) {
    const ok = await updateProfileCaEmail(applywizz_id, ca_email);
    if (ok) {
      profilesUpdated += 1;
      console.log(`[Backfill] ✅ ${applywizz_id} → ${ca_email}`);
    }
  }
  console.log(`[Backfill] Done — ${profilesUpdated} profiles updated`);

  const uniqueCaEmails = Array.from(new Set(rows.map((r) => r.ca_email))).sort();
  console.log(`[Backfill] Upserting ${uniqueCaEmails.length} operator users…`);
  for (const ca_email of uniqueCaEmails) {
    await upsertOperatorUser(ca_email);
    console.log(`[Backfill] users upsert — ${ca_email}`);
  }

  const sampleByCa = sampleApplywizzIdByCaEmail(rows);
  console.log(`[Backfill] Mapping ${uniqueCaEmails.length} operators to managers…`);
  for (const ca_email of uniqueCaEmails) {
    const applywizz_id = sampleByCa.get(ca_email);
    if (!applywizz_id) continue;

    const managerId = await fetchCareerAssociateManagerId(applywizz_id);
    if (!managerId) {
      console.warn(`[Backfill] ⚠️ No careerassociatemanagerid for ${ca_email} (via ${applywizz_id})`);
      continue;
    }

    const manager_email = managerEmailForCareerAssociateManagerId(managerId);
    if (!manager_email) {
      console.warn(`[Backfill] ⚠️ Unmapped manager id ${managerId} for ${ca_email}`);
      continue;
    }

    await setOperatorManagerEmail(ca_email, manager_email);
    console.log(`[Backfill] ✅ ${ca_email} → ${manager_email}`);
  }
}

main().catch((err) => {
  console.error('[Backfill] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
