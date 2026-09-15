/**
 * Supabase Auth user directory for display names and operator listings.
 */

import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { resolveRoleFromEmail, type AppRole } from './routes/auth.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Auth Directory');

export interface AuthDirectoryUser {
  id: string;
  email: string;
  displayName: string;
  role: AppRole;
  lastSignInAt: string | null;
  createdAt: string | null;
}

let directoryCache: { at: number; users: AuthDirectoryUser[] } | null = null;
const CACHE_MS = 60_000;

function displayNameFromMetadata(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string {
  const meta = user.user_metadata || {};
  const named = [meta.full_name, meta.name, meta.display_name]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  if (named) return named;
  const email = (user.email || '').trim().toLowerCase();
  return email.split('@')[0] || email || 'Unknown';
}

export async function listAuthDirectory(force = false): Promise<AuthDirectoryUser[]> {
  if (!force && directoryCache && Date.now() - directoryCache.at < CACHE_MS) {
    return directoryCache.users;
  }
  if (!isSupabaseConfigured()) return [];

  const users: AuthDirectoryUser[] = [];
  try {
    const supabase = getDbClient();
    let page = 1;
    while (page <= 20) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const batch = data?.users || [];
      for (const user of batch) {
        const email = (user.email || '').trim().toLowerCase();
        if (!email) continue;
        users.push({
          id: user.id,
          email,
          displayName: displayNameFromMetadata(user),
          role: resolveRoleFromEmail(email),
          lastSignInAt: user.last_sign_in_at || null,
          createdAt: user.created_at || null,
        });
      }
      if (batch.length < 200) break;
      page += 1;
    }
  } catch (err: any) {
    log.warn(`[Auth Directory] listUsers failed: ${err?.message}`);
    return directoryCache?.users || [];
  }

  directoryCache = { at: Date.now(), users };
  return users;
}

export async function displayNameMapForEmails(emails: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  if (unique.length === 0) return map;
  const users = await listAuthDirectory();
  const byEmail = new Map(users.map((user) => [user.email, user.displayName]));
  for (const email of unique) {
    map.set(email, byEmail.get(email) || email.split('@')[0] || email);
  }
  return map;
}

export function isActiveWithin(lastSignInAt: string | null | undefined, hours = 24): boolean {
  if (!lastSignInAt) return false;
  const at = Date.parse(lastSignInAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at <= hours * 60 * 60 * 1000;
}
