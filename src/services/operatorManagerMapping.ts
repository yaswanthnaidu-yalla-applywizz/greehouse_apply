/**
 * Maps operators to manager emails via ApplyWizz work-history careerassociatemanagerid.
 */

import {
  setDashboardUserManagerEmail,
  upsertDashboardUserOnSignIn,
  type DashboardUserRow,
  type UpsertDashboardUserResult,
} from '../db/users.js';
import {
  extractCareerAssociateManagerIdFromWorkHistoryPayload,
  fetchCareerAssociateManagerIdForCandidate,
  getYesterdayIST,
  type WorkHistoryResult,
} from './workHistoryClient.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Auth');

/** Known ApplyWizz CA manager UUID → dashboard manager email. */
export const CAREER_ASSOCIATE_MANAGER_ID_TO_EMAIL: Record<string, string> = {
  '9dc9376e-fbc5-440b-932f-38da10b89a70': 'balaji@applywizz.ai',
  'bebf9e8d-5bcc-4f77-b0a8-b8b80c3ca744': 'ramakrishnaa.tejavath@applywizz.ai',
};

export function managerEmailForCareerAssociateManagerId(managerId: string): string | null {
  const key = managerId.trim().toLowerCase();
  return CAREER_ASSOCIATE_MANAGER_ID_TO_EMAIL[key] ?? null;
}

/** True when operator manager_email should be resolved from work history. */
export function isManagerEmailUnset(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  return raw.trim() === '';
}

export function displayNameFromAuthUser(user?: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string {
  const meta = user?.user_metadata || {};
  for (const field of ['full_name', 'name', 'display_name']) {
    const value = meta[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const email = (user?.email || '').trim().toLowerCase();
  if (email.includes('@')) return email.split('@')[0];
  return email || 'User';
}

export const extractCareerAssociateManagerIdFromPayload =
  extractCareerAssociateManagerIdFromWorkHistoryPayload;

function logUpsertResultForAuth(email: string, result: UpsertDashboardUserResult): DashboardUserRow | null {
  const errPayload = result.error
    ? { message: result.error.message, code: result.error.code ?? null }
    : null;
  log.info(
    `[Auth] users upsert result — email: ${email}, data: ${JSON.stringify(result.data)}, error: ${JSON.stringify(errPayload)}`
  );
  if (result.error) {
    log.warn(`[Auth] users upsert failed — email: ${email}, code: ${result.error.code ?? 'n/a'}, message: ${result.error.message}`);
    const msg = (result.error.message || '').toLowerCase();
    if (result.error.code === '42501' || msg.includes('row-level security') || msg.includes('permission denied')) {
      log.warn(`[Auth] users upsert permission/RLS error — email: ${email} (check DB policy if unexpected)`);
    }
  }
  return result.data;
}

async function tryResolveManagerEmailForOperator(
  operatorEmail: string,
  whResult?: WorkHistoryResult
): Promise<void> {
  const unreachable = whResult?.unreachable ?? false;
  const candidateIds = whResult?.candidateIds ?? [];
  log.info(
    `[Auth] WorkHistory context — operator: ${operatorEmail}, unreachable: ${unreachable}, candidateCount: ${candidateIds.length}, resolvedDate: ${whResult?.resolvedDate ?? 'null'}`
  );

  if (candidateIds.length === 0) {
    log.warn(
      `[Auth] manager mapping skipped — operator: ${operatorEmail}, reason: no candidateIds from work history`
    );
    return;
  }

  const dateStr =
    whResult?.resolvedDate && /^\d{4}-\d{2}-\d{2}$/.test(whResult.resolvedDate)
      ? whResult.resolvedDate
      : getYesterdayIST();

  for (const candidateId of candidateIds) {
    const managerId = await fetchCareerAssociateManagerIdForCandidate(candidateId, dateStr);
    log.info(
      `[Auth] WorkHistory careerassociatemanagerid (raw) — operator: ${operatorEmail}, candidateId: ${candidateId}, value: ${managerId ?? 'null'}`
    );
    if (!managerId) continue;

    const managerEmail = managerEmailForCareerAssociateManagerId(managerId);
    const matched = managerEmail != null;
    log.info(
      `[Auth] CA manager ID hardcoded map — operator: ${operatorEmail}, managerId: ${managerId}, matched: ${matched}`
    );

    if (!managerEmail) {
      log.warn(`[Auth] ⚠️ No mapping found for CA manager ID: ${managerId} — operator: ${operatorEmail}`);
      return;
    }

    const updated = await setDashboardUserManagerEmail(operatorEmail, managerEmail);
    if (updated) {
      log.info(`[Auth] ✅ manager_email set to ${managerEmail} — operator: ${operatorEmail}`);
    } else {
      log.warn(
        `[Auth] manager_email update failed — operator: ${operatorEmail}, targetManager: ${managerEmail} (see [Users] logs)`
      );
    }
    return;
  }

  log.warn(
    `[Auth] manager mapping skipped — operator: ${operatorEmail}, reason: no careerassociatemanagerid on any candidate (${candidateIds.length} tried)`
  );
}

/**
 * Upserts dashboard user row and maps operator → manager when manager_email is unset.
 */
export async function syncDashboardUserAfterSignIn(input: {
  email: string;
  role: string;
  authUser?: { email?: string | null; user_metadata?: Record<string, unknown> | null };
  whResult?: WorkHistoryResult;
}): Promise<DashboardUserRow | null> {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail) return null;

  log.info(`[Auth] syncDashboardUserAfterSignIn — email: ${normalizedEmail}, role: ${input.role}`);

  const name = displayNameFromAuthUser({
    email: normalizedEmail,
    user_metadata: input.authUser?.user_metadata ?? null,
  });

  const upsertResult = await upsertDashboardUserOnSignIn({
    email: normalizedEmail,
    name,
    role: input.role,
  });
  const row = logUpsertResultForAuth(normalizedEmail, upsertResult);

  if (upsertResult.error || !row) {
    log.warn(
      `[Auth] manager mapping skipped — email: ${normalizedEmail}, reason: users upsert did not return a row`
    );
    return row;
  }

  const roleIsOperator = input.role === 'operator';
  if (!roleIsOperator) {
    log.info(
      `[Auth] manager mapping skipped — email: ${normalizedEmail}, role: ${input.role} (not operator)`
    );
    return row;
  }

  const managerEmailUnset = isManagerEmailUnset(row.manager_email);
  log.info(
    `[Auth] Checking manager mapping — email: ${normalizedEmail}, role: ${input.role}, manager_email: ${JSON.stringify(row.manager_email)}, roleIsOperator: ${roleIsOperator}, managerEmailUnset: ${managerEmailUnset}`
  );

  if (!managerEmailUnset) {
    log.info(
      `[Auth] manager mapping skipped — email: ${normalizedEmail}, manager_email already set: ${row.manager_email}`
    );
    return row;
  }

  await tryResolveManagerEmailForOperator(normalizedEmail, input.whResult);
  return row;
}
