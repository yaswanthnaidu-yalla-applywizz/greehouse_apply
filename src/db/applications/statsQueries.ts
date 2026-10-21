/**
 * @fileoverview Statistics, metrics, counts, and range aggregation queries for applications.
 */

import { getDbClient, isSupabaseConfigured } from "../client.js";
import { createLogger } from "../../utils/logger.js";
import { applicationRowHasPersistedResolution } from "../../dashboard/candidateQueueFilter.js";
import { memoryApplications } from "./memoryStore.js";
import {
  SUBMITTED_STATUSES,
  FAILED_EQUIVALENT_STATUSES,
  OPERATOR_WORKLOAD_STATUSES,
  type ApplicationRow,
  type ApplicationStatus,
  type CandidateApplicationAggregate,
  type CandidateApplicationAggregateRow,
  type CreatedAtRangeFilter,
  type GteLteQuery,
  type RequiredFieldFailuresByCA,
} from "./types.js";
import { deriveCandidateQueueStatus } from "./dto.js";

const log = createLogger("ApplicationsStats");

export function getISTDateRangeUtc(dateStr: string): { startIso: string; endIso: string } {
  const [yyyy, mm, dd] = dateStr.split('-').map(Number);
  const startDate = new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0, 0) - (5.5 * 60 * 60 * 1000));
  const endDate = new Date(Date.UTC(yyyy, mm - 1, dd + 1, 0, 0, 0, 0) - (5.5 * 60 * 60 * 1000));
  return {
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
  };
}

export async function countSubmittedApplicationsSince(
  startIso?: string,
  assignedCaEmails?: string[],
  endIso?: string | null
): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const emails = assignedCaEmails?.map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails && emails.length === 0) return 0;

  try {
    let query = getDbClient()
      .from('gh_candidate_applications')
      .select('id', { count: 'exact', head: true })
      .in('status', SUBMITTED_STATUSES);
    if (startIso) query = query.or(`submitted_at.gte.${startIso},and(submitted_at.is.null,updated_at.gte.${startIso})`);
    if (endIso) query = query.or(`submitted_at.lt.${endIso},and(submitted_at.is.null,updated_at.lt.${endIso})`);
    if (emails) query = query.in('assigned_ca_email', emails);
    const { count, error } = await query;
    if (error) {
      log.warn(`[DB] submitted count failed: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  } catch (err: any) {
    log.warn(`[DB] submitted count exception: ${err?.message}`);
    return 0;
  }
}

/** Legacy alias for backward compatibility */
export const countCompletedApplicationsSince = countSubmittedApplicationsSince;

export async function countAppliedApplicationsSince(
  since?: string,
  assignedCaEmails?: string[],
  endIso?: string | null
): Promise<number> {
  if (!isSupabaseConfigured()) return 0;
  const emails = assignedCaEmails?.map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails && emails.length === 0) return 0;

  try {
    let query = getDbClient()
      .from('gh_candidate_applications')
      .select('id', { count: 'exact', head: true })
      .in('status', ['APPLIED', 'EMAIL_PROOF_PENDING']);
    if (since) query = query.or(`submitted_at.gte.${since},and(submitted_at.is.null,updated_at.gte.${since})`);
    if (endIso) query = query.or(`submitted_at.lt.${endIso},and(submitted_at.is.null,updated_at.lt.${endIso})`);
    if (emails) query = query.in('assigned_ca_email', emails);
    const { count, error } = await query;
    if (error) {
      log.warn(`[DB] applied count failed: ${error.message}`);
      return 0;
    }
    return count ?? 0;
  } catch (err: any) {
    log.warn(`[DB] applied count exception: ${err?.message}`);
    return 0;
  }
}

export async function countSubmittedApplicationsByOperatorSince(
  startIso: string,
  assignedCaEmails?: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!isSupabaseConfigured()) return result;
  const emails = assignedCaEmails?.map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails && emails.length === 0) return result;

  try {
    let query = getDbClient()
      .from('gh_candidate_applications')
      .select('assigned_ca_email')
      .in('status', SUBMITTED_STATUSES)
      .gte('submitted_at', startIso);
    if (emails) query = query.in('assigned_ca_email', emails);
    const { data, error } = await query;
    if (error) {
      log.warn(`[DB] submitted operator counts failed: ${error.message}`);
      return result;
    }
    for (const row of data || []) {
      const email = String(row.assigned_ca_email || '').trim().toLowerCase();
      if (email) result.set(email, (result.get(email) || 0) + 1);
    }
  } catch (err: any) {
    log.warn(`[DB] submitted operator counts exception: ${err?.message}`);
  }
  return result;
}

/** Legacy alias for backward compatibility */
export const countCompletedApplicationsByOperatorSince = countSubmittedApplicationsByOperatorSince;

export async function countAppliedApplicationsByOperatorSince(
  startIso: string,
  assignedCaEmails?: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!isSupabaseConfigured()) return result;
  const emails = assignedCaEmails?.map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails && emails.length === 0) return result;

  try {
    let query = getDbClient()
      .from('gh_candidate_applications')
      .select('assigned_ca_email')
      .in('status', ['APPLIED', 'EMAIL_PROOF_PENDING'])
      .gte('submitted_at', startIso);
    if (emails) query = query.in('assigned_ca_email', emails);
    const { data, error } = await query;
    if (error) {
      log.warn(`[DB] applied operator counts failed: ${error.message}`);
      return result;
    }
    for (const row of data || []) {
      const email = String(row.assigned_ca_email || '').trim().toLowerCase();
      if (email) result.set(email, (result.get(email) || 0) + 1);
    }
  } catch (err: any) {
    log.warn(`[DB] applied operator counts exception: ${err?.message}`);
  }
  return result;
}


export function applyCreatedAtRangeFilter<T extends GteLteQuery>(
  query: T,
  range: CreatedAtRangeFilter
): T {
  let q = query.gte('created_at', range.startIso) as T;
  if (range.endIso) {
    q = q.lt('created_at', range.endIso) as T;
  }
  return q;
}

export function rowCreatedAtInRange(
  row: { created_at?: string | null },
  range: CreatedAtRangeFilter
): boolean {
  const ts = row.created_at;
  if (!ts) return false;
  const time = new Date(ts).getTime();
  if (time < new Date(range.startIso).getTime()) return false;
  if (range.endIso && time >= new Date(range.endIso).getTime()) return false;
  return true;
}

/**
 * Caches an application record in local memory for dry-run/submit lookups.
 */

export async function countOperatorWorkloadByProfileCaEmail(
  operatorEmails: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const emails = [...new Set(operatorEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0 || !isSupabaseConfigured()) return counts;

  const emailSet = new Set(emails);
  const { data, error } = await getDbClient()
    .from('gh_candidate_applications')
    .select('id, profiles!inner(ca_email)')
    .in('status', OPERATOR_WORKLOAD_STATUSES);

  if (error) {
    log.warn(`[DB] countOperatorWorkloadByProfileCaEmail failed: ${error.message}`);
    return counts;
  }

  for (const row of data || []) {
    const caEmail = ((row as { profiles?: { ca_email?: string | null } }).profiles?.ca_email || '')
      .trim()
      .toLowerCase();
    if (!caEmail || !emailSet.has(caEmail)) continue;
    counts.set(caEmail, (counts.get(caEmail) || 0) + 1);
  }
  return counts;
}


export async function getRequiredFieldFailuresByCA(): Promise<RequiredFieldFailuresByCA[]> {
  if (!isSupabaseConfigured()) return [];

  const { data, error } = await getDbClient()
    .from('gh_candidate_applications')
    .select('id, assigned_ca_email')
    .not('assigned_ca_email', 'is', null)
    .or('error_message.ilike.%required%,error_message.ilike.%unresolved%');

  if (error) {
    log.warn(`[DB] getRequiredFieldFailuresByCA failed: ${error.message}`);
    return [];
  }

  const grouped = new Map<string, string[]>();
  for (const row of data || []) {
    const caEmail = String(row.assigned_ca_email || '').trim().toLowerCase();
    if (!caEmail) continue;
    const applicationId = String(row.id || '').trim();
    const ids = grouped.get(caEmail) || [];
    if (applicationId) ids.push(applicationId);
    grouped.set(caEmail, ids);
  }

  return Array.from(grouped.entries())
    .map(([ca_email, application_ids]) => ({
      ca_email,
      failure_count: application_ids.length,
      application_ids,
    }))
    .sort((a, b) => b.failure_count - a.failure_count);
}

/**
 * Updates application lifecycle status.
 */

export async function getSubmissionOutcomeCounts(options?: {
  date?: string;
  createdAtRange?: CreatedAtRangeFilter;
  allowedCandidateIds?: string[];
}): Promise<{
  successfulApplications: number;
  failedApplications: number;
}> {
  const allowedSet = options?.allowedCandidateIds && options.allowedCandidateIds.length > 0
    ? new Set(options.allowedCandidateIds.map((id) => id.toUpperCase()))
    : null;

  const legacyDay =
    options?.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date) ? getISTDateRangeUtc(options.date) : null;
  const createdAtRange =
    options?.createdAtRange ??
    (legacyDay ? { startIso: legacyDay.startIso, endIso: legacyDay.endIso } : null);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let appliedQuery = supabase
        .from('gh_candidate_applications')
        .select('*', { count: 'exact', head: true })
        .in('status', ['APPLIED', 'EMAIL_PROOF_PENDING']);

      let failedQuery = supabase
        .from('gh_candidate_applications')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'FAILED');

      if (allowedSet && options?.allowedCandidateIds) {
        appliedQuery = appliedQuery.in('applywizz_id', options.allowedCandidateIds);
        failedQuery = failedQuery.in('applywizz_id', options.allowedCandidateIds);
      }

      if (createdAtRange) {
        appliedQuery = appliedQuery
          .or(`submitted_at.gte.${createdAtRange.startIso},and(submitted_at.is.null,updated_at.gte.${createdAtRange.startIso})`)
          .or(`submitted_at.lt.${createdAtRange.endIso},and(submitted_at.is.null,updated_at.lt.${createdAtRange.endIso})`);
        failedQuery = failedQuery
          .or(`submitted_at.gte.${createdAtRange.startIso},and(submitted_at.is.null,updated_at.gte.${createdAtRange.startIso})`)
          .or(`submitted_at.lt.${createdAtRange.endIso},and(submitted_at.is.null,updated_at.lt.${createdAtRange.endIso})`);
      }

      const [appliedRes, failedRes] = await Promise.all([appliedQuery, failedQuery]);
      if (!appliedRes.error && !failedRes.error) {
        return {
          successfulApplications: appliedRes.count ?? 0,
          failedApplications: failedRes.count ?? 0,
        };
      }
    } catch {
      // Fall through to in-memory counts
    }
  }

  const seen = new Set<string>();
  let successfulApplications = 0;
  let failedApplications = 0;
  for (const row of memoryApplications.values()) {
    if (allowedSet && !allowedSet.has(row.applywizz_id.toUpperCase())) {
      continue;
    }

    if (
      createdAtRange &&
      (!row.submitted_at ||
        new Date(row.submitted_at).getTime() < new Date(createdAtRange.startIso).getTime() ||
        (createdAtRange.endIso &&
          new Date(row.submitted_at).getTime() >= new Date(createdAtRange.endIso).getTime()))
    ) {
      continue;
    }

    const key = `${row.applywizz_id}::${row.job_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.status === 'APPLIED' || row.status === 'EMAIL_PROOF_PENDING') successfulApplications++;
    else if (FAILED_EQUIVALENT_STATUSES.includes(row.status)) failedApplications++;
  }
  return { successfulApplications, failedApplications };
}

export async function getDashboardApplicationMetrics(options?: {
  createdAtRange?: CreatedAtRangeFilter;
  allowedCandidateIds?: string[];
}): Promise<{
  totalApplications: number;
  totalCandidates: number;
  uniqueScannedJobs: number;
  totalFieldsPopulated: number;
  supabaseTaggedCount: number;
  aiTaggedCount: number;
  resumeTaggedCount: number;
}> {
  const allowedSet =
    options?.allowedCandidateIds && options.allowedCandidateIds.length > 0
      ? new Set(options.allowedCandidateIds.map((id) => id.toUpperCase()))
      : null;
  const range = options?.createdAtRange;

  let totalApplications = 0;
  let totalFieldsPopulated = 0;
  let supabaseTaggedCount = 0;
  let aiTaggedCount = 0;
  let resumeTaggedCount = 0;
  const candidateIds = new Set<string>();
  const jobUrls = new Set<string>();

  const tallyRow = (row: ApplicationRow) => {
    if (allowedSet && !allowedSet.has(row.applywizz_id.toUpperCase())) return;
    if (range && !rowCreatedAtInRange(row, range)) return;
    if (row.status === 'SKIPPED') return;
    totalApplications += 1;
    candidateIds.add(row.applywizz_id.toUpperCase());
    if (row.job_url) jobUrls.add(row.job_url);
    const fields = Array.isArray(row.resolved_fields) ? row.resolved_fields : [];
    for (const f of fields) {
      totalFieldsPopulated += 1;
      if (f?.source === 'supabase') supabaseTaggedCount += 1;
      if (f?.source === 'ai') aiTaggedCount += 1;
      if (f?.source === 'resume') resumeTaggedCount += 1;
    }
  };

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('gh_candidate_applications')
        .select('applywizz_id, job_url, status, resolved_fields, created_at');
      if (allowedSet && options?.allowedCandidateIds) {
        query = query.in('applywizz_id', options.allowedCandidateIds);
      }
      if (range) {
        query = applyCreatedAtRangeFilter(query, range);
      }
      const { data, error } = await query;
      if (!error && data) {
        for (const row of data as ApplicationRow[]) {
          tallyRow(row);
        }
        return {
          totalApplications,
          totalCandidates: candidateIds.size,
          uniqueScannedJobs: jobUrls.size,
          totalFieldsPopulated,
          supabaseTaggedCount,
          aiTaggedCount,
          resumeTaggedCount,
        };
      }
    } catch {
      // fall through
    }
  }

  for (const row of memoryApplications.values()) {
    tallyRow(row);
  }

  return {
    totalApplications,
    totalCandidates: candidateIds.size,
    uniqueScannedJobs: jobUrls.size,
    totalFieldsPopulated,
    supabaseTaggedCount,
    aiTaggedCount,
    resumeTaggedCount,
  };
}

/** Distinct applywizz IDs with non-SKIPPED applications in the dashboard date range (dev/admin list hydration). */
export async function distinctApplywizzIdsForCreatedAtRange(
  createdAtRange: CreatedAtRangeFilter
): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    let query = getDbClient()
      .from('gh_candidate_applications')
      .select('applywizz_id, status, created_at')
      .neq('status', 'SKIPPED');
    query = applyCreatedAtRangeFilter(query, createdAtRange);
    const { data, error } = await query;
    if (error) {
      log.warn(`[Applications] distinctApplywizzIdsForCreatedAtRange failed: ${error.message}`);
      return [];
    }
    const ids = new Set<string>();
    for (const row of (data || []) as ApplicationRow[]) {
      if (!rowCreatedAtInRange(row, createdAtRange)) continue;
      if (row.status === 'SKIPPED') continue;
      const id = String(row.applywizz_id || '').trim().toUpperCase();
      if (id) ids.add(id);
    }
    return Array.from(ids);
  } catch (err: any) {
    log.warn(`[Applications] distinctApplywizzIdsForCreatedAtRange exception: ${err?.message || err}`);
    return [];
  }
}

/**
 * Lists candidate applications with optional status and candidate filters.
 */

export async function fetchCandidateApplicationAggregatesByApplywizzIds(
  applywizzIds: string[],
  options?: {
    createdAtRange?: CreatedAtRangeFilter;
    includeRow?: (row: CandidateApplicationAggregateRow) => boolean;
  }
): Promise<Map<string, CandidateApplicationAggregate>> {
  const aggregates = new Map<string, CandidateApplicationAggregate>();
  const ids = [...new Set(applywizzIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return aggregates;
  }

  const statusesByKey = new Map<string, ApplicationStatus[]>();
  let loadedFromSupabase = false;
  const scoped = Boolean(options?.createdAtRange || options?.includeRow);

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('gh_candidate_applications')
        .select(
          scoped
            ? 'applywizz_id, status, assigned_ca_email, resolved_fields, created_at'
            : 'applywizz_id, status'
        )
        .in('applywizz_id', ids);
      if (options?.createdAtRange) {
        query = applyCreatedAtRangeFilter(query, options.createdAtRange);
      }
      const { data, error } = await query;
      if (!error && data) {
        loadedFromSupabase = true;
        for (const row of data) {
          const aggregateRow = row as unknown as CandidateApplicationAggregateRow;
          if (options?.includeRow && !options.includeRow(aggregateRow)) continue;
          const key = String(aggregateRow.applywizz_id || '').trim().toUpperCase();
          if (!key) continue;
          const list = statusesByKey.get(key) || [];
          list.push(aggregateRow.status as ApplicationStatus);
          statusesByKey.set(key, list);
        }
      }
    } catch {
      // fall through to memory
    }
  }

  if (!loadedFromSupabase) {
    for (const app of memoryApplications.values()) {
      const key = app.applywizz_id.trim().toUpperCase();
      if (!ids.some((id) => id.toUpperCase() === key)) continue;
      const aggregateRow: CandidateApplicationAggregateRow = {
        applywizz_id: app.applywizz_id,
        status: app.status,
        assigned_ca_email: app.assigned_ca_email,
        resolved_fields: app.resolved_fields,
        created_at: app.created_at,
      };
      if (options?.createdAtRange && !rowCreatedAtInRange(app, options.createdAtRange)) continue;
      if (options?.includeRow && !options.includeRow(aggregateRow)) continue;
      const list = statusesByKey.get(key) || [];
      list.push(app.status);
      statusesByKey.set(key, list);
    }
  }

  for (const id of ids) {
    const key = id.toUpperCase();
    const statuses = statusesByKey.get(key) || [];
    aggregates.set(key, {
      job_count: statuses.length,
      queue_status: deriveCandidateQueueStatus(statuses),
    });
  }

  return aggregates;
}

/**
 * Count candidate_applications per applywizz_id, excluding SKIPPED and unresolved placeholders (dashboard queue size).
 */
export async function countNonSkippedApplicationsByApplywizzIds(
  applywizzIds: string[],
  createdAtRange?: CreatedAtRangeFilter
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = [...new Set(applywizzIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return counts;
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase
        .from('gh_candidate_applications')
        .select('applywizz_id, status, resolved_fields, created_at')
        .in('applywizz_id', ids);
      if (createdAtRange) {
        query = applyCreatedAtRangeFilter(query, createdAtRange);
      }
      const { data, error } = await query;
      if (!error && data) {
        for (const row of data) {
          if (row.status === 'SKIPPED') continue;
          if (!applicationRowHasPersistedResolution(row)) continue;
          const key = String(row.applywizz_id || '').trim().toUpperCase();
          if (!key) continue;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return counts;
      }
    } catch {
      // fall through
    }
  }

  for (const app of memoryApplications.values()) {
    if (app.status === 'SKIPPED') continue;
    if (!applicationRowHasPersistedResolution(app)) continue;
    if (createdAtRange && !rowCreatedAtInRange(app, createdAtRange)) continue;
    const key = app.applywizz_id.trim().toUpperCase();
    if (!ids.some((id) => id.toUpperCase() === key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/** Count applications in a given status (Supabase head count, memory fallback). */
export async function countApplicationsByStatus(
  status: ApplicationStatus,
  createdAtRange?: CreatedAtRangeFilter
): Promise<number> {
  if (isSupabaseConfigured()) {
    try {
      let query = getDbClient()
        .from('gh_candidate_applications')
        .select('*', { count: 'exact', head: true })
        .eq('status', status);
      if (createdAtRange) query = applyCreatedAtRangeFilter(query, createdAtRange);
      const { count, error } = await query;
      if (!error && typeof count === 'number') {
        return count;
      }

    } catch {
      // fall through
    }
  }
  return Array.from(memoryApplications.values()).filter((a) =>
    a.status === status && (!createdAtRange || rowCreatedAtInRange(a, createdAtRange))
  ).length;
}

/**
 * Releases queue claims left behind by a crashed worker. Stale attempts are
 * never requeued automatically; they become operator-visible RETRY rows.
 */
