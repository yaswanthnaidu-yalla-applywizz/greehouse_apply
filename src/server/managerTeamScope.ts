/**
 * Manager team scope via dashboard `users.manager_email` → operator CA emails.
 */

import {
  applyCreatedAtRangeFilter,
  type CreatedAtRangeFilter,
} from '../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { listOperatorEmailsForManager } from '../db/users.js';
import type { AuthenticatedRequest } from './middleware/auth.js';
import { isUserAdmin, resolveRoleFromEmail } from './routes/auth.js';
import { getAuthenticatedCaEmail } from './workHistoryAuth.js';
import { resolveRoleFromRequest, type AppRole } from './routes/requireRole.js';
import {
  fetchAllowedCandidates,
  type WorkHistoryCandidateRecord,
} from '../services/workHistoryClient.js';
import type { DashboardCreatedAtRange } from './dashboardDateRange.js';
import { istDatesForWorkHistory } from './dashboardDateRange.js';
import { mergeWorkHistoryForCaEmails, mergeWorkHistoryForIstDates } from './workHistorySpan.js';
import { setCachedWorkHistory } from './workHistoryCache.js';
import type { Response } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ManagerTeamScope');

export const VIEW_AS_OPERATOR_HEADER = 'x-view-as';
export const VIEW_AS_MANAGER_EMAIL_HEADER = 'x-view-as-manager-email';

/** True when header value is `operator` (case-insensitive). */
export function isViewAsOperatorHeaderValue(raw: string | string[] | undefined): boolean {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.trim().toLowerCase() === 'operator';
}

function headerString(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Manager email whose team is scoped when X-View-As: operator is active.
 * Manager JWT → own email (ignores X-View-As-Manager-Email). Dev → header email if manager role.
 */
export function resolveViewAsOperatorManagerEmail(req: AuthenticatedRequest): string | null {
  if (!isViewAsOperatorHeaderValue(req.headers[VIEW_AS_OPERATOR_HEADER])) return null;
  const role = resolveRoleFromRequest(req);
  if (role === 'manager') {
    const email = getAuthenticatedCaEmail(req);
    return email ? email.trim().toLowerCase() : null;
  }
  if (role === 'dev') {
    const email = headerString(req.headers[VIEW_AS_MANAGER_EMAIL_HEADER]);
    if (!email.includes('@')) return null;
    if (resolveRoleFromEmail(email) !== 'manager') return null;
    return email;
  }
  return null;
}

export function isViewAsOperatorTeamScope(req: AuthenticatedRequest): boolean {
  return resolveViewAsOperatorManagerEmail(req) != null;
}

/** Manager session with X-View-As: operator — operator-style candidate APIs scoped to their team. */
export function isManagerViewAsOperator(req: AuthenticatedRequest): boolean {
  if (resolveRoleFromRequest(req) !== 'manager') return false;
  return isViewAsOperatorHeaderValue(req.headers[VIEW_AS_OPERATOR_HEADER]);
}

export async function resolveManagerViewAsOperatorScope(
  managerEmail: string,
  createdAtRange?: CreatedAtRangeFilter
): Promise<{
  allowedIds: Set<string>;
  teamOperatorEmails: string[];
}> {
  const manager = managerEmail.trim().toLowerCase();
  const teamOperatorEmails = await listOperatorEmailsForManager(manager);
  const profileIds = await applywizzIdsForManagerTeamProfiles(manager);
  const dbIds = await distinctApplywizzIdsForOperatorEmails(teamOperatorEmails, createdAtRange);
  const allowedIds = new Set<string>();
  for (const id of [...profileIds, ...dbIds]) {
    allowedIds.add(id.trim().toUpperCase());
  }
  return {
    teamOperatorEmails,
    allowedIds,
  };
}

export async function applywizzIdsForManagerTeamProfiles(managerEmail: string): Promise<string[]> {
  const operatorEmails = await listOperatorEmailsForManager(managerEmail);
  if (operatorEmails.length === 0 || !isSupabaseConfigured()) return [];

  const { data, error } = await getDbClient()
    .from('profiles')
    .select('applywizz_id')
    .in('ca_email', operatorEmails);

  if (error) {
    log.warn(`[ManagerTeamScope] profiles team query failed: ${error.message}`);
    return [];
  }

  const ids = new Set<string>();
  for (const row of data || []) {
    const id = String((row as { applywizz_id?: string }).applywizz_id || '').trim().toUpperCase();
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export function resolveRequestAppRole(req: AuthenticatedRequest, email?: string | null): AppRole | null {
  return resolveRoleFromRequest(req) ?? resolveRoleFromEmail(email) ?? null;
}

/** Dev and admin see all candidates/applications; dev bypasses filters in guards too. */
export function hasUnrestrictedDashboardAccess(role: AppRole | null): boolean {
  return role === 'dev' || role === 'admin';
}

export async function distinctApplywizzIdsForOperatorEmails(
  operatorEmails: string[],
  createdAtRange?: CreatedAtRangeFilter
): Promise<string[]> {
  const emails = [...new Set(operatorEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0 || !isSupabaseConfigured()) return [];

  let query = getDbClient()
    .from('candidate_applications')
    .select('applywizz_id')
    .in('assigned_ca_email', emails);
  if (createdAtRange) {
    query = applyCreatedAtRangeFilter(query, createdAtRange);
  }
  const { data, error } = await query;
  if (error) return [];

  const ids = new Set<string>();
  for (const row of data || []) {
    const id = String((row as { applywizz_id?: string }).applywizz_id || '').trim().toUpperCase();
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

export async function resolveTeamCandidateIdsForManager(
  managerEmail: string,
  dates: string[],
  createdAtRange?: CreatedAtRangeFilter
): Promise<{
  operatorEmails: string[];
  candidateIds: string[];
  records: WorkHistoryCandidateRecord[];
  unreachable: boolean;
  warning?: string;
}> {
  const manager = managerEmail.trim().toLowerCase();
  const operatorEmails = await listOperatorEmailsForManager(manager);
  if (operatorEmails.length === 0) {
    return {
      operatorEmails: [],
      candidateIds: [],
      records: [],
      unreachable: false,
      warning: 'No operators are assigned to this manager yet.',
    };
  }

  const wh = await mergeWorkHistoryForCaEmails(operatorEmails, dates);
  const dbIds = await distinctApplywizzIdsForOperatorEmails(operatorEmails, createdAtRange);
  const merged = new Set<string>();
  for (const id of [...wh.candidateIds, ...dbIds]) {
    merged.add(id.trim().toUpperCase());
  }

  return {
    operatorEmails,
    candidateIds: Array.from(merged),
    records: wh.records,
    unreachable: wh.unreachable,
    warning: wh.unreachable ? 'Work history API was unreachable for one or more operators.' : undefined,
  };
}

export function isUserAdminRequest(req: AuthenticatedRequest, email?: string | null): boolean {
  const role = resolveRequestAppRole(req, email);
  if (role === 'dev' || role === 'admin') return true;
  return isUserAdmin(req.user || email);
}

export function applicationAssignedCaAllowed(
  assignedCaEmail: string | null | undefined,
  viewerEmail: string,
  role: AppRole | null,
  teamOperatorEmails: string[] | null
): boolean {
  if (hasUnrestrictedDashboardAccess(role)) return true;
  const assigned = (assignedCaEmail || '').trim().toLowerCase();
  if (role === 'manager' && teamOperatorEmails && teamOperatorEmails.length > 0) {
    const team = new Set(teamOperatorEmails.map((e) => e.trim().toLowerCase()));
    if (!assigned) return true;
    return team.has(assigned);
  }
  if (!viewerEmail) return false;
  if (!assigned) return true;
  return assigned === viewerEmail.trim().toLowerCase();
}

/** Ops mode (X-View-As): dev/admin must not bypass CA filters; use manager team operator set. */
export function applicationAssignedCaAllowedForRequest(
  assignedCaEmail: string | null | undefined,
  viewerEmail: string,
  role: AppRole | null,
  teamOperatorEmails: string[] | null,
  viewAsManagerEmail: string | null
): boolean {
  if (viewAsManagerEmail) {
    return applicationAssignedCaAllowed(
      assignedCaEmail,
      viewerEmail,
      'manager',
      teamOperatorEmails
    );
  }
  return applicationAssignedCaAllowed(assignedCaEmail, viewerEmail, role, teamOperatorEmails);
}

export interface DashboardCandidateAccess {
  unrestricted: boolean;
  viewAsManagerEmail: string | null;
  role: AppRole | null;
  userEmail: string | null;
  allowedIds: Set<string> | null;
  teamOperatorEmails: string[] | null;
  workHistoryRecords: WorkHistoryCandidateRecord[];
  workHistoryUnreachable: boolean;
  createdAtRange: CreatedAtRangeFilter;
  authError?: string;
}

/**
 * Resolves allowed candidate IDs for per-candidate dashboard routes (detail, jobs, resume).
 * Mirrors GET /api/candidates list scoping for the same date query.
 */
export async function resolveDashboardCandidateAccess(
  req: AuthenticatedRequest,
  parsedRange: DashboardCreatedAtRange,
  res?: Response
): Promise<DashboardCandidateAccess> {
  const userEmail = getAuthenticatedCaEmail(req);
  const role = resolveRequestAppRole(req, userEmail);
  const viewAsManagerEmail = resolveViewAsOperatorManagerEmail(req);
  const unrestricted = hasUnrestrictedDashboardAccess(role) && !viewAsManagerEmail;
  const createdAtRange = { startIso: parsedRange.startIso, endIso: parsedRange.endIso };
  const whDates = istDatesForWorkHistory(parsedRange);

  if (unrestricted) {
    return {
      unrestricted: true,
      viewAsManagerEmail,
      role,
      userEmail,
      allowedIds: null,
      teamOperatorEmails: null,
      workHistoryRecords: [],
      workHistoryUnreachable: false,
      createdAtRange,
    };
  }

  if (!userEmail && !viewAsManagerEmail) {
    return {
      unrestricted: false,
      viewAsManagerEmail,
      role,
      userEmail,
      allowedIds: new Set(),
      teamOperatorEmails: null,
      workHistoryRecords: [],
      workHistoryUnreachable: false,
      createdAtRange,
      authError: 'Unauthorized: CA email missing — cannot proceed',
    };
  }

  let candidateIds: string[] = [];
  let teamOperatorEmails: string[] | null = null;
  let workHistoryRecords: WorkHistoryCandidateRecord[] = [];
  let workHistoryUnreachable = false;

  if (viewAsManagerEmail) {
    res?.setHeader('X-View-As-Active', 'true');
    const team = await resolveTeamCandidateIdsForManager(
      viewAsManagerEmail,
      whDates,
      createdAtRange
    );
    candidateIds = team.candidateIds;
    teamOperatorEmails = team.operatorEmails;
    workHistoryRecords = team.records;
    workHistoryUnreachable = team.unreachable;
  } else if (role === 'manager' && userEmail) {
    const team = await resolveTeamCandidateIdsForManager(userEmail, whDates, createdAtRange);
    candidateIds = team.candidateIds;
    teamOperatorEmails = team.operatorEmails;
    workHistoryRecords = team.records;
    workHistoryUnreachable = team.unreachable;
  } else if (userEmail) {
    const caEmail = userEmail;
    const merged = await mergeWorkHistoryForIstDates({
      mode: 'ca',
      caEmail,
      dates: whDates,
    });
    candidateIds = merged.candidateIds;
    workHistoryRecords = merged.records;
    workHistoryUnreachable = merged.unreachable;
    if (candidateIds.length === 0 && parsedRange.preset === 'default') {
      const allowedResult = await fetchAllowedCandidates(caEmail);
      if (allowedResult.candidateIds.length > 0) {
        candidateIds = allowedResult.candidateIds;
        workHistoryRecords = allowedResult.records;
        workHistoryUnreachable = allowedResult.unreachable;
        setCachedWorkHistory(
          caEmail,
          allowedResult.records,
          allowedResult.candidateIds,
          allowedResult.unreachable,
          allowedResult.resolvedDate
        );
      }
    }
  }

  return {
    unrestricted: false,
    viewAsManagerEmail,
    role,
    userEmail,
    allowedIds: new Set(candidateIds.map((id) => id.toUpperCase())),
    teamOperatorEmails,
    workHistoryRecords,
    workHistoryUnreachable,
    createdAtRange,
  };
}

export function isApplywizzIdInDashboardAccess(applywizzId: string, access: DashboardCandidateAccess): boolean {
  if (access.unrestricted) return true;
  return access.allowedIds?.has(applywizzId.toUpperCase()) ?? false;
}
