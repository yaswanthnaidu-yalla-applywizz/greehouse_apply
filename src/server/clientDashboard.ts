/**
 * Shared client-table rollup used by the manager home view and admin manager drill-down.
 */

import {
  rowCreatedAtInRange,
  getISTDateRangeUtc,
  type ApplicationRow,
  type CreatedAtRangeFilter,
} from '../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { config } from '../config/env.js';
import { getISTDateString } from '../services/workHistoryClient.js';
import { displayNameMapForEmails } from './authDirectory.js';
import { listOperatorEmailsForManager } from '../db/users.js';
import { applywizzIdsForManagerTeamProfiles } from './managerTeamScope.js';
import { createLogger } from '../utils/logger.js';
import {
  getApplicationStats,
  statusMetricsForTransition,
  type ApplicationStatsResult,
} from '../db/applicationStats.js';
import { listAllDashboardUsers, listDashboardOperatorsForManager } from '../db/users.js';

const log = createLogger('Client Dashboard');

/**
 * Team scoping via ApplyWizz `careerassociatemanager_id` is off until we know
 * which manager email maps to which CA manager id. Flip this to true to restore
 * per-manager client lists.
 */
export const MANAGER_TEAM_SCOPE_ENABLED = true;

export interface ManagerApplicationRow extends ApplicationRow {
  profiles?: {
    applywizz_id?: string | null;
    client_name?: string | null;
    ca_email?: string | null;
  } | null;
}

export interface ApplicationDetail {
  id: string;
  job_url: string;
  company_name: string;
  job_title: string;
  status: string;
  proof_web_url: string;
  proof_email_url: string;
  proof_email_json: ApplicationRow['proof_email_json'] | null;
  error_message: string;
}

export interface ManagerClientRow {
  client: string;
  applywizzId: string;
  applications: number | null;
  submitted: number | null;
  completed?: number | null;
  applied: number | null;
  pending: number;
  failed: number | null;
  waitingForEmail: number;
  assignedTo: string;
  assignedToEmail: string;
  /** CA email from `candidate_applications.assigned_ca_email` */
  ca_email: string;
  /** CA email from `profiles.ca_email` (work-history backfill) */
  assigned_ca: string;
  submittedApplications: ApplicationDetail[];
  completedApplications?: ApplicationDetail[];
  pendingApplications: ApplicationDetail[];
  failedApplications: ApplicationDetail[];
  expanded_details: {
    submitted: ApplicationDetail[];
    failed: ApplicationDetail[];
    pending: ApplicationDetail[];
  };
}

export interface ClientDashboardResult {
  date: string;
  dateRange: { preset: string; from: string | null; to: string | null; label: string };
  ca: string;
  managerEmail: string;
  rows: ManagerClientRow[];
  clients: string[];
  totals: {
    applications: number | null;
    submitted: number | null;
    applied: number | null;
    failed: number | null;
    pending: number;
    waiting_for_email: number;
  };
  statsAvailable: boolean;
  statsPartial: boolean;
  statsAvailableFrom: string | null;
  byOperator: ApplicationStatsResult['byOperator'];
  warning?: string;
}

function clientName(row: ManagerApplicationRow): string {
  return row.profiles?.client_name?.trim() || row.applywizz_id;
}

function assignedCaEmail(row: ManagerApplicationRow): string {
  return (row.assigned_ca_email || '').trim().toLowerCase();
}

function profileCaEmail(row: ManagerApplicationRow): string {
  return (row.profiles?.ca_email || '').trim().toLowerCase();
}

function isWaitingForEmail(row: ManagerApplicationRow): boolean {
  return row.status === 'EMAIL_PROOF_PENDING' || row.status === 'OTP_REQUIRED';
}

function detailFor(row: ManagerApplicationRow, includeProofs: boolean): ApplicationDetail {
  return {
    id: row.id || '',
    job_url: row.job_url,
    company_name: row.company_name || '',
    job_title: row.job_title || '',
    status: row.status,
    proof_web_url: includeProofs ? row.proof_web_url || '' : '',
    proof_email_url: includeProofs ? row.proof_email_url || '' : '',
    proof_email_json: includeProofs ? row.proof_email_json || null : null,
    error_message: row.error_message || '',
  };
}

export async function fetchLinkedCaIds(managerEmail: string): Promise<{ ids: string[]; warning?: string }> {
  const email = managerEmail.trim().toLowerCase();
  if (!email) return { ids: [], warning: 'Manager email is required.' };
  try {
    const configuredUrl = new URL(config.APPLYWIZZ_API_URL);
    configuredUrl.search = '';
    configuredUrl.searchParams.set('careerassociatemanager_id', email);

    const response = await fetch(configuredUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'ApplyWizz-Greenhouse-Automation/1.0' },
    });
    if (!response.ok) {
      log.warn(`[Client Dashboard] ApplyWizz API HTTP ${response.status} for ${email}`);
      return { ids: [], warning: `ApplyWizz API returned HTTP ${response.status}.` };
    }

    const payload: unknown = await response.json();
    const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(root.candidates)
        ? root.candidates
        : Array.isArray(root.clients)
          ? root.clients
          : Array.isArray(root.data)
            ? root.data
            : [];

    const ids = candidates.flatMap((candidate) => {
      if (typeof candidate === 'string') return [candidate];
      if (!candidate || typeof candidate !== 'object') return [];
      const row = candidate as Record<string, unknown>;
      const id = row.applywizz_id ?? row.applywizzId ?? row.client_id ?? row.clientId;
      return typeof id === 'string' && id.trim() ? [id.trim()] : [];
    });
    return { ids: Array.from(new Set(ids)) };
  } catch (err: any) {
    log.warn(`[Client Dashboard] ApplyWizz API failed for ${email}: ${err?.message}`);
    return { ids: [], warning: 'ApplyWizz API unreachable.' };
  }
}

export function emptyClientDashboard(
  date: string,
  dateRange: ClientDashboardResult['dateRange'],
  managerEmail: string,
  ca: string,
  warning?: string,
  stats?: ApplicationStatsResult
): ClientDashboardResult {
  return {
    date,
    dateRange,
    ca,
    managerEmail,
    rows: [],
    clients: [],
    totals: {
      applications: stats?.counts.total ?? (stats?.available === false ? null : 0),
      submitted: stats?.counts.submitted ?? (stats?.available === false ? null : 0),
      applied: stats?.counts.applied ?? (stats?.available === false ? null : 0),
      failed: stats?.counts.failed ?? (stats?.available === false ? null : 0),
      pending: 0,
      waiting_for_email: 0,
    },
    statsAvailable: stats?.available ?? false,
    statsPartial: stats?.partial ?? false,
    statsAvailableFrom: stats?.availableFrom ?? null,
    byOperator: stats?.byOperator ?? [],
    warning,
  };
}

export async function loadClientDashboard(options: {
  managerEmail: string;
  date?: string;
  createdAtRange?: CreatedAtRangeFilter;
  dateRangeMeta?: ClientDashboardResult['dateRange'];
  ca?: string;
  /** Dev/admin on manager UI: all applications and operators, not manager_email team. */
  teamScopeUnrestricted?: boolean;
}): Promise<ClientDashboardResult> {
  const date = options.date || getISTDateString();
  const dateRange = options.dateRangeMeta || {
    preset: 'legacy_day',
    from: date,
    to: date,
    label: date,
  };
  const requestedCa = (options.ca || 'all').trim() || 'all';
  const managerEmail = options.managerEmail.trim().toLowerCase();

  if (!isSupabaseConfigured()) {
    return emptyClientDashboard(date, dateRange, managerEmail, requestedCa, 'Manager dashboard requires Supabase.');
  }

  const createdAtRange =
    options.createdAtRange ??
    (() => {
      const { startIso, endIso } = getISTDateRangeUtc(date);
      return { startIso, endIso };
    })();

  const applyManagerTeamScope = MANAGER_TEAM_SCOPE_ENABLED && !options.teamScopeUnrestricted;
  let teamOperatorEmails: string[] = [];
  if (applyManagerTeamScope) {
    teamOperatorEmails = await listOperatorEmailsForManager(managerEmail);
    if (teamOperatorEmails.length === 0) {
      const stats = await getApplicationStats({
        range: { fromDate: dateRange.from || date, toDate: dateRange.to || date },
        scope: { managerEmail },
        includeBreakdown: true,
      });
      return emptyClientDashboard(
        date,
        dateRange,
        managerEmail,
        requestedCa,
        'No operators are assigned to this manager yet.',
        stats
      );
    }
  }

  let query = getDbClient()
    .from('gh_candidate_applications')
    .select('*, profiles!inner(applywizz_id, client_name, ca_email)');
  if (createdAtRange) {
    if (createdAtRange.endIso) {
      query = query.or(
        `and(created_at.gte.${createdAtRange.startIso},created_at.lt.${createdAtRange.endIso}),and(submitted_at.gte.${createdAtRange.startIso},submitted_at.lt.${createdAtRange.endIso})`
      );
    } else {
      query = query.or(
        `created_at.gte.${createdAtRange.startIso},submitted_at.gte.${createdAtRange.startIso}`
      );
    }
  }

  let warning: string | undefined;
  if (applyManagerTeamScope) {
    const teamCandidateIds = await applywizzIdsForManagerTeamProfiles(managerEmail);
    const emailsFormatted = teamOperatorEmails.map((e) => `"${e}"`).join(',');
    if (teamCandidateIds.length > 0) {
      const idsFormatted = teamCandidateIds.map((id) => `"${id}"`).join(',');
      query = query.or(`assigned_ca_email.in.(${emailsFormatted}),applywizz_id.in.(${idsFormatted})`);
    } else {
      query = query.in('assigned_ca_email', teamOperatorEmails);
    }
  }

  const { data, error } = await query;

  if (error) throw error;

  const rawRows = (data || []) as ManagerApplicationRow[];
  const nameMap = await displayNameMapForEmails(rawRows.map(assignedCaEmail));
  let requestedCaEmail: string | undefined;
  if (requestedCa.toLowerCase() !== 'all') {
    const userRows = applyManagerTeamScope
      ? await listDashboardOperatorsForManager(managerEmail)
      : (await listAllDashboardUsers()).filter((user) => user.role.trim().toLowerCase() === 'operator');
    const needle = requestedCa.toLowerCase();
    requestedCaEmail = [
      ...rawRows.map((row) => ({
        email: assignedCaEmail(row),
        name: nameMap.get(assignedCaEmail(row)) || '',
      })),
      ...userRows.map((user) => ({ email: user.email.trim().toLowerCase(), name: user.name || '' })),
    ].find(({ email, name }) =>
      email === needle || name.trim().toLowerCase() === needle || email.split('@')[0] === needle
    )?.email;
    if (!requestedCaEmail && needle.includes('@')) requestedCaEmail = needle;
    if (!requestedCaEmail) throw new Error(`Unable to resolve selected career associate "${requestedCa}".`);
  }

  const stats = await getApplicationStats({
    range: { fromDate: dateRange.from || date, toDate: dateRange.to || date },
    scope: {
      managerEmail: applyManagerTeamScope ? managerEmail : undefined,
      caEmail: requestedCaEmail,
    },
    includeBreakdown: true,
  });
  const grouped = new Map<string, ManagerClientRow>();

  for (const application of rawRows) {
    const email = assignedCaEmail(application);
    const profileCa = profileCaEmail(application);
    const assignedName = nameMap.get(email) || email.split('@')[0];
    if (requestedCa.toLowerCase() !== 'all') {
      if (email !== requestedCaEmail) continue;
    }

    const isCreatedInRange = rowCreatedAtInRange(application, createdAtRange);
    const submittedAt = application.submitted_at || (
      application.status === 'APPLIED' || application.status === 'EMAIL_PROOF_PENDING'
        ? (application.proof_captured_at || application.reviewed_at || application.updated_at)
        : null
    );
    const isSubmittedAtInRange = Boolean(
      submittedAt &&
      submittedAt >= createdAtRange.startIso &&
      (!createdAtRange.endIso || submittedAt < createdAtRange.endIso)
    );

    if (!isCreatedInRange && !isSubmittedAtInRange) {
      continue;
    }

    const name = clientName(application);
    const row = grouped.get(application.applywizz_id) || {
      client: name,
      applywizzId: application.applywizz_id,
      applications: 0,
      submitted: 0,
      applied: 0,
      pending: 0,
      failed: 0,
      waitingForEmail: 0,
      assignedTo: assignedName,
      assignedToEmail: email,
      ca_email: email,
      assigned_ca: profileCa,
      submittedApplications: [],
      pendingApplications: [],
      failedApplications: [],
      expanded_details: { submitted: [], failed: [], pending: [] },
    };
    row.applications = (row.applications ?? 0) + 1;
    row.assignedTo = assignedName || row.assignedTo;
    row.assignedToEmail = email || row.assignedToEmail;
    row.ca_email = email || row.ca_email;
    row.assigned_ca = profileCa || row.assigned_ca;

    const isPending = application.status === 'READY_FOR_REVIEW';
    const statusMetrics = statusMetricsForTransition(application.status);
    const isSubmitted = statusMetrics.includes('submitted');
    const isApplied = statusMetrics.includes('applied') && isSubmittedAtInRange;
    const isFailed = statusMetrics.includes('failed');

    if (isApplied) {
      row.applied = (row.applied ?? 0) + 1;
    }

    if (isSubmitted) {
      row.submitted = (row.submitted ?? 0) + 1;
      const detail = detailFor(application, true);
      row.submittedApplications.push(detail);
      row.expanded_details.submitted.push(detail);
    }

    if (isFailed) {
      row.failed = (row.failed ?? 0) + 1;
      const detail = detailFor(application, false);
      row.failedApplications.push(detail);
      row.expanded_details.failed.push(detail);
    } else if (isPending) {
      row.pending += 1;
      const detail = detailFor(application, false);
      row.pendingApplications.push(detail);
      row.expanded_details.pending.push(detail);
    }
    if (isWaitingForEmail(application)) row.waitingForEmail += 1;
    row.completed = row.submitted;
    row.completedApplications = row.submittedApplications;
    grouped.set(application.applywizz_id, row);
  }

  const missingCandidateIds = stats.byCandidate
    .map((candidate) => candidate.applywizzId)
    .filter((id) => !grouped.has(id));
  const candidateProfiles = new Map<string, { client_name?: string | null; ca_email?: string | null }>();
  for (let i = 0; i < missingCandidateIds.length; i += 200) {
    const { data: profiles, error: profilesError } = await getDbClient()
      .from('profiles')
      .select('applywizz_id, client_name, ca_email')
      .in('applywizz_id', missingCandidateIds.slice(i, i + 200));
    if (profilesError) throw new Error(`Unable to load historical stats profiles: ${profilesError.message}`);
    for (const profile of profiles || []) {
      candidateProfiles.set(profile.applywizz_id, profile);
    }
  }
  const statEmails = stats.byCandidate.flatMap((candidate) => candidate.caEmails);
  const statNameMap = await displayNameMapForEmails(statEmails);
  for (const candidate of stats.byCandidate) {
    const profile = candidateProfiles.get(candidate.applywizzId);
    const caEmail = candidate.caEmails[0] || profile?.ca_email?.trim().toLowerCase() || '';
    const assignedName = statNameMap.get(caEmail) || caEmail.split('@')[0];
    const row = grouped.get(candidate.applywizzId) || {
      client: profile?.client_name?.trim() || candidate.applywizzId,
      applywizzId: candidate.applywizzId,
      applications: 0,
      submitted: 0,
      applied: 0,
      pending: 0,
      failed: 0,
      waitingForEmail: 0,
      assignedTo: assignedName,
      assignedToEmail: caEmail,
      ca_email: caEmail,
      assigned_ca: profile?.ca_email?.trim().toLowerCase() || '',
      submittedApplications: [],
      pendingApplications: [],
      failedApplications: [],
      expanded_details: { submitted: [], failed: [], pending: [] },
    };
    row.applications = candidate.total ?? 0;
    row.submitted = candidate.submitted ?? 0;
    row.completed = row.submitted;
    row.applied = candidate.applied ?? 0;
    row.failed = candidate.failed ?? 0;
    grouped.set(candidate.applywizzId, row);
  }

  const candidateStats = new Map(stats.byCandidate.map((candidate) => [candidate.applywizzId, candidate]));
  for (const row of grouped.values()) {
    const candidate = candidateStats.get(row.applywizzId);
    row.applications = stats.available ? candidate?.total ?? 0 : null;
    row.submitted = stats.available ? candidate?.submitted ?? 0 : null;
    row.completed = row.submitted ?? undefined;
    row.applied = stats.available ? candidate?.applied ?? 0 : null;
    row.failed = stats.available ? candidate?.failed ?? 0 : null;
  }

  const rows = Array.from(grouped.values());
  const liveTotals = rows.reduce(
    (total, row) => ({
      pending: total.pending + row.pending,
      waiting_for_email: total.waiting_for_email + row.waitingForEmail,
    }),
    { pending: 0, waiting_for_email: 0 }
  );
  const totals = {
    applications: stats.available ? stats.counts.total : null,
    submitted: stats.available ? stats.counts.submitted : null,
    applied: stats.available ? stats.counts.applied : null,
    failed: stats.available ? stats.counts.failed : null,
    pending: liveTotals.pending,
    waiting_for_email: liveTotals.waiting_for_email,
  };

  return {
    date,
    dateRange,
    ca: requestedCa.toLowerCase() === 'all' ? 'all' : requestedCa,
    managerEmail,
    rows,
    clients: rows.map((row) => row.client),
    totals,
    statsAvailable: stats.available,
    statsPartial: stats.partial,
    statsAvailableFrom: stats.availableFrom,
    byOperator: stats.byOperator,
    warning,
  };
}
