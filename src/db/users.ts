/**
 * Dashboard `users` table — sign-in upsert and operator manager_email mapping.
 */

import { getDbClient, isSupabaseConfigured } from './client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Users');
const authLog = createLogger('Auth');

let missingTableWarned = false;

function isMissingUsersTable(error: { message?: string; code?: string } | null | undefined): boolean {
  const message = (error?.message || '').toLowerCase();
  return error?.code === '42P01' || (message.includes('gh_users') && message.includes('does not exist'));
}

function warnMissingUsersTable(error: { message?: string }): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  log.warn(`[Users] gh_users table is missing (${error.message}). Apply migration 017.`);
}

export interface DashboardUserRow {
  email: string;
  name: string | null;
  role: string;
  manager_email: string | null;
}

export type UpsertDashboardUserError = { message: string; code?: string };

export type UpsertDashboardUserResult = {
  data: DashboardUserRow | null;
  error: UpsertDashboardUserError | null;
};

export async function getDashboardUserByEmail(email: string): Promise<DashboardUserRow | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !isSupabaseConfigured()) return null;

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('gh_users')
    .select('email, name, role, manager_email')
    .eq('email', normalized)
    .maybeSingle();

  if (error) {
    if (isMissingUsersTable(error)) {
      warnMissingUsersTable(error);
      return null;
    }
    log.warn(`[Users] getDashboardUserByEmail failed: ${error.message}`);
    return null;
  }

  return data as DashboardUserRow | null;
}

export async function upsertDashboardUserOnSignIn(input: {
  email: string;
  name: string;
  role: string;
}): Promise<UpsertDashboardUserResult> {
  const normalized = input.email.trim().toLowerCase();
  if (!normalized) {
    authLog.info('[Auth] gh_users upsert result: data=null error=email missing');
    return { data: null, error: { message: 'email missing' } };
  }
  if (!isSupabaseConfigured()) {
    authLog.info(`[Auth] gh_users upsert result: data=null error=Supabase not configured`);
    return { data: null, error: { message: 'Supabase not configured' } };
  }

  const existing = await getDashboardUserByEmail(normalized);
  const row = {
    email: normalized,
    name: input.name.trim() || null,
    role: input.role,
    manager_email: existing?.manager_email ?? null,
    updated_at: new Date().toISOString(),
  };

  authLog.info(`[Auth] Attempting gh_users upsert for ${normalized}`);

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('gh_users')
    .upsert(row, { onConflict: 'email' })
    .select('email, name, role, manager_email')
    .maybeSingle();

  const resolved = (data as DashboardUserRow | null) ?? (error ? null : { ...row, name: row.name });
  authLog.info(
    `[Auth] users upsert result: data=${JSON.stringify(resolved)} error=${error?.message ?? 'null'}`
  );

  if (error) {
    if (isMissingUsersTable(error)) {
      warnMissingUsersTable(error);
    } else {
      log.warn(
        `[Users] upsertDashboardUserOnSignIn failed: ${error.message}${error.code ? ` (code ${error.code})` : ''}`
      );
    }
    return {
      data: null,
      error: { message: error.message, code: error.code },
    };
  }

  return { data: resolved, error: null };
}

export async function listOperatorEmailsForManager(managerEmail: string): Promise<string[]> {
  const rows = await listDashboardOperatorsForManager(managerEmail);
  return rows.map((row) => row.email);
}

export async function listDashboardOperatorsForManager(
  managerEmail: string
): Promise<DashboardUserRow[]> {
  const manager = managerEmail.trim().toLowerCase();
  if (!manager || !isSupabaseConfigured()) return [];

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('gh_users')
    .select('email, name, role, manager_email')
    .eq('manager_email', manager)
    .order('email');

  if (error) {
    if (isMissingUsersTable(error)) {
      warnMissingUsersTable(error);
      return [];
    }
    log.warn(`[Users] listDashboardOperatorsForManager failed: ${error.message}`);
    return [];
  }

  return (data as DashboardUserRow[]) || [];
}

export async function listAllDashboardUsers(): Promise<DashboardUserRow[]> {
  if (!isSupabaseConfigured()) return [];

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('gh_users')
    .select('email, name, role, manager_email')
    .order('email');

  if (error) {
    if (isMissingUsersTable(error)) {
      warnMissingUsersTable(error);
      return [];
    }
    log.warn(`[Users] listAllDashboardUsers failed: ${error.message}`);
    return [];
  }

  return (data as DashboardUserRow[]) || [];
}

export async function setDashboardUserManagerEmail(
  email: string,
  managerEmail: string
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const manager = managerEmail.trim().toLowerCase();
  if (!normalized || !manager || !isSupabaseConfigured()) return false;

  const supabase = getDbClient();
  const { error } = await supabase
    .from('gh_users')
    .update({ manager_email: manager, updated_at: new Date().toISOString() })
    .eq('email', normalized);

  if (error) {
    if (isMissingUsersTable(error)) {
      warnMissingUsersTable(error);
      return false;
    }
    log.warn(`[Users] setDashboardUserManagerEmail failed: ${error.message}`);
    return false;
  }

  return true;
}
