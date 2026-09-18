/**
 * Shared client-table rollup used by the manager home view and admin manager drill-down.
 */

import {
  applyCreatedAtRangeFilter,
  getISTDateRangeUtc,
  hydrateApplicationProofUrls,
  type ApplicationRow,
  type CreatedAtRangeFilter,
} from '../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { config } from '../config/env.js';
import { getISTDateString } from '../services/workHistoryClient.js';
import { displayNameMapForEmails } from './authDirectory.js';
import { listOperatorEmailsForManager } from '../db/users.js';
import { createLogger } from '../utils/logger.js';

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
  applications: number;
  completed: number;
  applied: number;
  pending: number;
  failed: number;
  waitingForEmail: number;
  assignedTo: string;
  assignedToEmail: string;
  /** CA email from `candidate_applications.assigned_ca_email` */
  ca_email: string;
  /** CA email from `profiles.ca_email` (work-history backfill) */
  assigned_ca: string;
  completedApplications: ApplicationDetail[];
  pendingApplications: ApplicationDetail[];
  failedApplications: ApplicationDetail[];
  expanded_details: {
    completed: ApplicationDetail[];
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
    applications: number;
    applied: number;
    failed: number;
    pending: number;
    waiting_for_email: number;
  };
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
  warning?: string
): ClientDashboardResult {
  return {
    date,
    dateRange,
    ca,
    managerEmail,
    rows: [],
    clients: [],
    totals: { applications: 0, applied: 0, failed: 0, pending: 0, waiting_for_email: 0 },
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

  let query = getDbClient()
    .from('candidate_applications')
    .select('*, profiles!inner(applywizz_id, client_name, ca_email)');
  query = applyCreatedAtRangeFilter(query, createdAtRange);

  let warning: string | undefined;
  const applyManagerTeamScope = MANAGER_TEAM_SCOPE_ENABLED && !options.teamScopeUnrestricted;
  if (applyManagerTeamScope) {
    const operatorEmails = await listOperatorEmailsForManager(managerEmail);
    if (operatorEmails.length === 0) {
      return emptyClientDashboard(
        date,
        dateRange,
        managerEmail,
        requestedCa,
        'No operators are assigned to this manager yet.'
      );
    }
    query = query.in('assigned_ca_email', operatorEmails);
  }

  const { data, error } = await query;

  if (error) throw error;

  const rawRows = (data || []) as ManagerApplicationRow[];
  const hydrated = await Promise.all(
    rawRows.map(async (row) => (row.status === 'APPLIED' ? hydrateApplicationProofUrls(row) : row))
  );

  const nameMap = await displayNameMapForEmails(hydrated.map(assignedCaEmail));
  const grouped = new Map<string, ManagerClientRow>();

  for (const application of hydrated) {
    const email = assignedCaEmail(application);
    const profileCa = profileCaEmail(application);
    const assignedName = nameMap.get(email) || email.split('@')[0];
    if (requestedCa.toLowerCase() !== 'all') {
      const needle = requestedCa.toLowerCase();
      if (email !== needle && assignedName.toLowerCase() !== needle) continue;
    }

    const name = clientName(application);
const row = grouped.get(name) || {
       client: name,
       applywizzId: application.applywizz_id,
       applications: 0,
       completed: 0,
       applied: 0,
       pending: 0,
       failed: 0,
       waitingForEmail: 0,
       assignedTo: assignedName,
       assignedToEmail: email,
       ca_email: email,
       assigned_ca: profileCa,
       completedApplications: [],
       pendingApplications: [],
       failedApplications: [],
       expanded_details: { completed: [], failed: [], pending: [] },
     };
    row.applications += 1;
    row.assignedTo = assignedName || row.assignedTo;
    row.assignedToEmail = email || row.assignedToEmail;
    row.ca_email = email || row.ca_email;
    row.assigned_ca = profileCa || row.assigned_ca;

    const isCompleted =
      application.status === 'QUEUED' ||
      application.status === 'APPLYING' ||
      application.status === 'APPLIED' ||
      application.status === 'EMAIL_PROOF_PENDING' ||
      application.status === 'EMAIL_UNVERIFIED';

    const isApplied = application.status === 'APPLIED';

    if (isCompleted) {
      row.completed += 1;
      if (isApplied) {
        row.applied += 1;
      }
      const detail = detailFor(application, true);
      row.completedApplications.push(detail);
      row.expanded_details.completed.push(detail);
    } else if (application.status === 'FAILED' || application.status === 'CAPTCHA_TIMEOUT') {
      row.failed += 1;
      const detail = detailFor(application, false);
      row.failedApplications.push(detail);
      row.expanded_details.failed.push(detail);
    } else {
      row.pending += 1;
      const detail = detailFor(application, false);
      row.pendingApplications.push(detail);
      row.expanded_details.pending.push(detail);
    }
    if (isWaitingForEmail(application)) row.waitingForEmail += 1;
    grouped.set(name, row);
  }

  const rows = Array.from(grouped.values());
const totals = rows.reduce(
  (total, row) => ({
    applications: total.applications + row.applications,
    applied: total.applied + row.applied,
    failed: total.failed + row.failed,
    pending: total.pending + row.pending,
    waiting_for_email: total.waiting_for_email + row.waitingForEmail,
  }),
  { applications: 0, applied: 0, failed: 0, pending: 0, waiting_for_email: 0 }
);

  return {
    date,
    dateRange,
    ca: requestedCa.toLowerCase() === 'all' ? 'all' : requestedCa,
    managerEmail,
    rows,
    clients: rows.map((row) => row.client),
    totals,
    warning,
  };
}
