/**
 * Dashboard `users` table — sign-in upsert and operator manager_email mapping.
 */

import { getDbClient, isSupabaseConfigured } from './client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Users');

let missingTableWarned = false;

function isMissingUsersTable(error: { message?: string; code?: string } | null | undefined): boolean {
  const message = (error?.message || '').toLowerCase();
  return error?.code === '42P01' || (message.includes('users') && message.includes('does not exist'));
}

function warnMissingUsersTable(error: { message?: string }): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  log.warn(`[Users] users table is missing (${error.message}). Apply migration 017.`);
}

export interface DashboardUserRow {
  email: string;
  name: string | null;
  role: string;
  manager_email: string | null;
}

export async function getDashboardUserByEmail(email: string): Promise<DashboardUserRow | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !isSupabaseConfigured()) return null;

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('users')
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
}): Promise<DashboardUserRow | null> {
  const normalized = input.email.trim().toLowerCase();
  if (!normalized || !isSupabaseConfigured()) return null;

  const existing = await getDashboardUserByEmail(normalized);
  const row = {
    email: normalized,
    name: input.name.trim() || null,
    role: input.role,
    manager_email: existing?.manager_email ?? null,
    updated_at: new Date().toISOString(),
  };

  const supabase = getDbClient();
  const { data, error } = await supabase
    .from('users')
    .upsert(row, { onConflict: 'email' })
    .select('email, name, role, manager_email')
    .maybeSingle();

  if (error) {
    if (isMissingUsersTable(error)) {
      warnMissingUsersTable(error);
      return null;
    }
    log.warn(`[Users] upsertDashboardUserOnSignIn failed: ${error.message}`);
    return null;
  }

  return (data as DashboardUserRow | null) ?? { ...row, name: row.name };
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
    .from('users')
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
    .from('users')
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
    .from('users')
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
