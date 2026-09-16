/**
 * Admin manager list stats: operators / clients / apps via users + profiles.ca_email.
 */

import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { isActiveWithin, listAuthDirectory } from './authDirectory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Admin Manager Stats');

const MANAGER_ACTIVE_HOURS = 48;

export interface ManagerTeamStats {
  operators: number;
  clients: number;
  applications: number;
  status: 'active' | 'inactive';
}

function emptyStats(): ManagerTeamStats {
  return { operators: 0, clients: 0, applications: 0, status: 'inactive' };
}

/**
 * Live team metrics per manager email (not date-scoped).
 */
export async function buildManagerTeamStats(
  managerEmails: string[]
): Promise<Map<string, ManagerTeamStats>> {
  const managers = [
    ...new Set(managerEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  const result = new Map<string, ManagerTeamStats>();
  for (const email of managers) {
    result.set(email, emptyStats());
  }
  if (managers.length === 0 || !isSupabaseConfigured()) {
    return result;
  }

  const operatorEmailsByManager = new Map<string, Set<string>>();
  for (const m of managers) {
    operatorEmailsByManager.set(m, new Set());
  }

  const { data: operatorRows, error: usersError } = await getDbClient()
    .from('users')
    .select('email, role, manager_email')
    .eq('role', 'operator');

  if (usersError) {
    log.warn(`[Admin Manager Stats] users query failed: ${usersError.message}`);
    return result;
  }

  for (const row of operatorRows || []) {
    const manager = (row.manager_email || '').trim().toLowerCase();
    const email = (row.email || '').trim().toLowerCase();
    if (!manager || !email || !result.has(manager)) continue;
    const stats = result.get(manager)!;
    stats.operators += 1;
    operatorEmailsByManager.get(manager)!.add(email);
  }

  const caEmailToManager = new Map<string, string>();
  for (const [manager, emails] of operatorEmailsByManager) {
    for (const email of emails) {
      caEmailToManager.set(email, manager);
    }
  }

  const distinctClientsByManager = new Map<string, Set<string>>();
  for (const m of managers) {
    distinctClientsByManager.set(m, new Set());
  }

  const { data: profileRows, error: profilesError } = await getDbClient()
    .from('profiles')
    .select('applywizz_id, ca_email')
    .not('ca_email', 'is', null);

  if (profilesError) {
    log.warn(`[Admin Manager Stats] profiles query failed: ${profilesError.message}`);
  } else {
    for (const row of profileRows || []) {
      const caEmail = (row.ca_email || '').trim().toLowerCase();
      const applywizzId = (row.applywizz_id || '').trim().toUpperCase();
      if (!caEmail || !applywizzId) continue;
      const manager = caEmailToManager.get(caEmail);
      if (!manager) continue;
      distinctClientsByManager.get(manager)!.add(applywizzId);
    }
  }

  for (const [manager, ids] of distinctClientsByManager) {
    result.get(manager)!.clients = ids.size;
  }

  const { data: appRows, error: appsError } = await getDbClient()
    .from('candidate_applications')
    .select('id, profiles!inner(ca_email)');

  if (appsError) {
    log.warn(`[Admin Manager Stats] applications query failed: ${appsError.message}`);
  } else {
    for (const row of appRows || []) {
      const caEmail = (
        (row as { profiles?: { ca_email?: string | null } }).profiles?.ca_email || ''
      )
        .trim()
        .toLowerCase();
      if (!caEmail) continue;
      const manager = caEmailToManager.get(caEmail);
      if (!manager) continue;
      result.get(manager)!.applications += 1;
    }
  }

  const authByEmail = new Map(
    (await listAuthDirectory()).map((user) => [user.email, user.lastSignInAt])
  );

  for (const [manager, operatorEmails] of operatorEmailsByManager) {
    let active = false;
    for (const opEmail of operatorEmails) {
      if (isActiveWithin(authByEmail.get(opEmail), MANAGER_ACTIVE_HOURS)) {
        active = true;
        break;
      }
    }
    result.get(manager)!.status = active ? 'active' : 'inactive';
  }

  return result;
}
