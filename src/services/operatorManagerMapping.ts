/**
 * Maps operators to manager emails via ApplyWizz work-history careerassociatemanagerid.
 */

import { setDashboardUserManagerEmail, upsertDashboardUserOnSignIn, type DashboardUserRow } from '../db/users.js';
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

async function tryResolveManagerEmailForOperator(
  operatorEmail: string,
  whResult?: WorkHistoryResult
): Promise<void> {
  const candidateId = whResult?.candidateIds?.[0];
  if (!candidateId) return;

  const dateStr =
    whResult.resolvedDate && /^\d{4}-\d{2}-\d{2}$/.test(whResult.resolvedDate)
      ? whResult.resolvedDate
      : getYesterdayIST();

  const managerId = await fetchCareerAssociateManagerIdForCandidate(candidateId, dateStr);
  if (!managerId) return;

  const managerEmail = managerEmailForCareerAssociateManagerId(managerId);
  if (!managerEmail) {
    log.warn(`[Auth] ⚠️ No manager mapping found for careerassociatemanagerid ${managerId}`);
    return;
  }

  const updated = await setDashboardUserManagerEmail(operatorEmail, managerEmail);
  if (updated) {
    log.info(`[Auth] Mapped operator ${operatorEmail} → manager ${managerEmail}`);
  }
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

  const name = displayNameFromAuthUser({
    email: normalizedEmail,
    user_metadata: input.authUser?.user_metadata ?? null,
  });

  const row = await upsertDashboardUserOnSignIn({
    email: normalizedEmail,
    name,
    role: input.role,
  });

  if (input.role !== 'operator') return row;

  const managerEmail = row?.manager_email?.trim().toLowerCase();
  if (managerEmail) return row;

  await tryResolveManagerEmailForOperator(normalizedEmail, input.whResult);
  return row;
}
