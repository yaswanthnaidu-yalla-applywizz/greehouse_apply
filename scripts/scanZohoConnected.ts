/**
 * @fileoverview Zoho Mail Reader connected users scanner using REST API.
 *
 * Directly queries https://zoho-mail-reader.onrender.com/api/zoho/ui/users
 * and syncs connected mailboxes to the Supabase profiles table.
 *
 * Usage:
 *   npx tsx scripts/scanZohoConnected.ts
 */

import dotenv from 'dotenv';
import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';

dotenv.config();

export interface ZohoConnectedScanResult {
  scannedAt: string;
  count: number;
  emails: string[];
}

const BASE_URL = process.env.ZOHO_CONNECTOR_URL || 'https://zoho-mail-reader.onrender.com/';

export async function runZohoConnectedScan(): Promise<ZohoConnectedScanResult> {
  const scannedAt = new Date().toISOString();

  try {
    const baseUrl = BASE_URL.replace(/\/+$/, '');
    const zohoUrl = `${baseUrl}/api/zoho/ui/users`;
    const gmailUrl = `${baseUrl}/api/gmail/ui/users`;
    console.log(`[Mailbox Scanner] 🌐 Fetching connected users from Zoho and Gmail via REST API...`);

    const [zohoRes, gmailRes] = await Promise.allSettled([
      fetch(zohoUrl),
      fetch(gmailUrl),
    ]);

    const connectedEmailsSet = new Set<string>();

    if (zohoRes.status === 'fulfilled' && zohoRes.value.ok) {
      const data = (await zohoRes.value.json()) as { users?: Array<{ email: string; connected: boolean }> };
      const zohoUsers = data.users || [];
      const zohoConnected = zohoUsers
        .filter((u) => u.connected && u.email)
        .map((u) => u.email.toLowerCase().trim());
      console.log(`[Mailbox Scanner] 📊 Found ${zohoConnected.length} connected Zoho user(s) out of ${zohoUsers.length} total.`);
      for (const e of zohoConnected) connectedEmailsSet.add(e);
    } else {
      console.warn(`[Mailbox Scanner] ⚠️ Zoho fetch failed`);
    }

    if (gmailRes.status === 'fulfilled' && gmailRes.value.ok) {
      const data = (await gmailRes.value.json()) as { users?: Array<{ email: string; connected: boolean }> };
      const gmailUsers = data.users || [];
      const gmailConnected = gmailUsers
        .filter((u) => u.connected && u.email)
        .map((u) => u.email.toLowerCase().trim());
      console.log(`[Mailbox Scanner] 📊 Found ${gmailConnected.length} connected Gmail user(s) out of ${gmailUsers.length} total.`);
      for (const e of gmailConnected) connectedEmailsSet.add(e);
    } else {
      console.warn(`[Mailbox Scanner] ⚠️ Gmail fetch failed`);
    }

    const connectedEmails = Array.from(connectedEmailsSet);
    console.log(`[Mailbox Scanner] 📊 Total unified connected user(s): ${connectedEmails.length}`);

    if (isSupabaseConfigured() && connectedEmails.length > 0) {
      await syncConnectedProfiles(connectedEmails);
    }

    return {
      scannedAt,
      count: connectedEmails.length,
      emails: connectedEmails,
    };
  } catch (err: any) {
    console.error(`[Mailbox Scanner] ❌ Error scanning connected users: ${err.message}`);
    return {
      scannedAt,
      count: 0,
      emails: [],
    };
  }
}

async function syncConnectedProfiles(connectedEmails: string[]): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured; refusing to update the connected-user allowlist.');
  }

  const supabase = getDbClient();
  const allRowsFilter = '00000000-0000-0000-0000-000000000000';
  const { error: resetError } = await supabase
    .from('profiles')
    .update({ zoho_connected: false })
    .neq('id', allRowsFilter);
  if (resetError) {
    throw new Error(`Could not reset profiles.zoho_connected: ${resetError.message}`);
  }

  let connectedCount = 0;
  for (const email of connectedEmails) {
    const { count, error } = await supabase
      .from('profiles')
      .update({ zoho_connected: true }, { count: 'exact' })
      .eq('company_email', email);
    if (error) {
      throw new Error(`Could not mark ${email} Zoho-connected: ${error.message}`);
    }
    connectedCount += count ?? 0;
  }

  console.log(`[Zoho Scanner] ✅ Supabase upsert success: marked ${connectedCount} profiles Zoho-connected.`);
}

// Direct execution entrypoint
if (process.argv[1] && process.argv[1].includes('scanZohoConnected')) {
  runZohoConnectedScan()
    .then((res) => {
      console.log(`[Zoho Scanner] Finished scan with ${res.count} connected user(s).`);
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error('[Zoho Scanner] ❌ Fatal error:', err.message);
      process.exitCode = 1;
    });
}
