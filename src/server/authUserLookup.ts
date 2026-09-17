/**
 * Paginated Supabase Auth user lookup by email (GoTrue listUsers defaults to ~50 per page).
 */

import type { User } from '@supabase/supabase-js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';

export type AuthUserLookupError = { message: string };

export type AuthUserLookupResult = {
  user: User | null;
  error: AuthUserLookupError | null;
};

export type ListAuthUsersPageFn = (
  page: number,
  perPage: number
) => Promise<{ users: User[]; error: AuthUserLookupError | null }>;

const MAX_PAGES = 20;
const PER_PAGE = 200;

export function normalizeAuthLookupEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Paginated search; stops at first email match. */
export async function findAuthUserByEmailWithPager(
  normalizedEmail: string,
  listPage: ListAuthUsersPageFn
): Promise<AuthUserLookupResult> {
  if (!normalizedEmail) {
    return { user: null, error: null };
  }

  let page = 1;
  while (page <= MAX_PAGES) {
    const { users, error } = await listPage(page, PER_PAGE);
    if (error) {
      return { user: null, error };
    }
    const match = users.find((u) => normalizeAuthLookupEmail(u.email || '') === normalizedEmail);
    if (match) {
      return { user: match, error: null };
    }
    if (users.length < PER_PAGE) {
      break;
    }
    page += 1;
  }

  return { user: null, error: null };
}

export async function findAuthUserByEmail(email: string): Promise<AuthUserLookupResult> {
  const normalizedEmail = normalizeAuthLookupEmail(email);
  if (!normalizedEmail || !isSupabaseConfigured()) {
    return { user: null, error: null };
  }

  return findAuthUserByEmailWithPager(normalizedEmail, async (page, perPage) => {
    const supabase = getDbClient();
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      return { users: [], error: { message: error.message } };
    }
    return { users: data?.users ?? [], error: null };
  });
}
