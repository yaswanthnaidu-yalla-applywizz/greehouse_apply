import { getDbClient, isSupabaseConfigured } from './client.js';
import {
  getISTDateRangeUtc,
  listIstDatesInclusive,
  getIstCalendarDate,
  DashboardCreatedAtRange,
} from '../server/dashboardDateRange.js';
import { listOperatorEmailsForManager } from './users.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ApplicationStats');

export const APPLICATION_STATS_METRICS = ['total', 'submitted', 'applied', 'failed'] as const;
export type ApplicationStatsMetric = (typeof APPLICATION_STATS_METRICS)[number];
type ApplicationStatsScopeType = 'global' | 'manager' | 'ca' | 'manager_ca';

export interface ApplicationStatsRange {
  fromDate: string;
  toDate: string;
}

export interface ApplicationStatsScope {
  managerEmail?: string;
  caEmail?: string;
}

export interface ApplicationStatsCounts {
  total: number | null;
  submitted: number | null;
  applied: number | null;
  failed: number | null;
}

export interface ApplicationStatsBreakdown extends ApplicationStatsCounts {
  applywizzId: string;
  caEmails: string[];
}

export interface OperatorStatsBreakdown extends ApplicationStatsCounts {
  email: string;
}

export interface DateStatsBreakdown {
  date: string;
  counts: ApplicationStatsCounts;
}

export interface ApplicationStatsResult {
  available: boolean;
  partial: boolean;
  availableFrom: string;
  counts: ApplicationStatsCounts;
  byCandidate: ApplicationStatsBreakdown[];
  byOperator: OperatorStatsBreakdown[];
  byDate: DateStatsBreakdown[];
}

export interface ApplicationTrendPoint {
  bucketStart: string;
  successApplications: number;
  failedApplications: number;
  clients: number;
}

export interface ApplicationStatFactRow {
  event_date: string;
  application_id: string;
  applywizz_id: string;
  metric: ApplicationStatsMetric;
  ca_email: string | null;
}
type StatDayRow = ApplicationStatFactRow;

export interface ApplicationCohortRow {
  id: string;
  applywizz_id: string;
  status: string;
  assigned_ca_email: string | null;
  created_at: string;
  first_attempted_at?: string | null;
}

const EMPTY_COUNTS: ApplicationStatsCounts = {
  total: 0,
  submitted: 0,
  applied: 0,
  failed: 0,
};

function emptyCounts(): ApplicationStatsCounts {
  return { ...EMPTY_COUNTS };
}

export function isAttemptedStatus(status: string): boolean {
  return status !== 'READY_FOR_REVIEW' && status !== 'SKIPPED' && status !== 'FILTERED_OUT';
}

export function isAttemptedRow(row: { status: string; first_attempted_at?: string | null }): boolean {
  return Boolean(row.first_attempted_at) || isAttemptedStatus(row.status);
}

export function isSuccessStatus(status: string): boolean {
  return status === 'APPLIED' || status === 'EMAIL_PROOF_PENDING';
}

export function isFailedStatus(status: string): boolean {
  return status === 'FAILED';
}

export function resolveStatsScope(scope: ApplicationStatsScope): {
  scopeType: ApplicationStatsScopeType;
  scopeKey: string;
} {
  const managerEmail = scope.managerEmail?.trim().toLowerCase() || '';
  const caEmail = scope.caEmail?.trim().toLowerCase() || '';
  if (managerEmail && caEmail) {
    return { scopeType: 'manager_ca', scopeKey: `${managerEmail}|${caEmail}` };
  }
  if (managerEmail) return { scopeType: 'manager', scopeKey: managerEmail };
  if (caEmail) return { scopeType: 'ca', scopeKey: caEmail };
  return { scopeType: 'global', scopeKey: '' };
}

function createBreakdown(): ApplicationStatsBreakdown {
  return { applywizzId: '', ...emptyCounts(), caEmails: [] };
}

function incrementMetric(counts: ApplicationStatsCounts, metric: ApplicationStatsMetric): void {
  if (metric === 'total') counts.total = (counts.total ?? 0) + 1;
  else counts[metric] = (counts[metric] ?? 0) + 1;
}

export function statusMetricsForTransition(status: string): ApplicationStatsMetric[] {
  const metrics: ApplicationStatsMetric[] = [];
  if (status !== 'READY_FOR_REVIEW' && status !== 'SKIPPED' && status !== 'FILTERED_OUT') metrics.push('submitted');
  if (status === 'APPLIED' || status === 'EMAIL_PROOF_PENDING') metrics.push('applied');
  if (status === 'FAILED') metrics.push('failed');
  return metrics;
}

export function summarizeApplicationCohortRows(rows: ApplicationCohortRow[]): {
  counts: ApplicationStatsCounts;
  byCandidate: ApplicationStatsBreakdown[];
  byOperator: OperatorStatsBreakdown[];
  byDate: DateStatsBreakdown[];
} {
  const counts = emptyCounts();
  const candidates = new Map<string, ApplicationStatsBreakdown>();
  const operators = new Map<string, OperatorStatsBreakdown>();
  const dates = new Map<string, ApplicationStatsCounts>();

  for (const row of rows) {
    counts.total = (counts.total ?? 0) + 1;
    const attempted = isAttemptedRow(row);
    const success = isSuccessStatus(row.status);
    const failed = isFailedStatus(row.status);

    if (attempted) counts.submitted = (counts.submitted ?? 0) + 1;
    if (success) counts.applied = (counts.applied ?? 0) + 1;
    if (failed) counts.failed = (counts.failed ?? 0) + 1;

    // Date bucket in IST
    const istCreated = getIstCalendarDate(new Date(row.created_at)).isoDate;
    let dateCounts = dates.get(istCreated);
    if (!dateCounts) {
      dateCounts = emptyCounts();
      dates.set(istCreated, dateCounts);
    }
    dateCounts.total = (dateCounts.total ?? 0) + 1;
    if (attempted) dateCounts.submitted = (dateCounts.submitted ?? 0) + 1;
    if (success) dateCounts.applied = (dateCounts.applied ?? 0) + 1;
    if (failed) dateCounts.failed = (dateCounts.failed ?? 0) + 1;

    // Candidate breakdown
    const candidateId = String(row.applywizz_id || '').trim();
    if (candidateId) {
      let candidate = candidates.get(candidateId);
      if (!candidate) {
        candidate = { ...createBreakdown(), applywizzId: candidateId };
        candidates.set(candidateId, candidate);
      }
      candidate.total = (candidate.total ?? 0) + 1;
      if (attempted) candidate.submitted = (candidate.submitted ?? 0) + 1;
      if (success) candidate.applied = (candidate.applied ?? 0) + 1;
      if (failed) candidate.failed = (candidate.failed ?? 0) + 1;

      const caEmail = row.assigned_ca_email?.trim().toLowerCase();
      if (caEmail && !candidate.caEmails.includes(caEmail)) {
        candidate.caEmails.push(caEmail);
      }
    }

    // Operator breakdown
    const opEmail = row.assigned_ca_email?.trim().toLowerCase();
    if (opEmail) {
      let operator = operators.get(opEmail);
      if (!operator) {
        operator = { email: opEmail, ...emptyCounts() };
        operators.set(opEmail, operator);
      }
      operator.total = (operator.total ?? 0) + 1;
      if (attempted) operator.submitted = (operator.submitted ?? 0) + 1;
      if (success) operator.applied = (operator.applied ?? 0) + 1;
      if (failed) operator.failed = (operator.failed ?? 0) + 1;
    }
  }

  return {
    counts,
    byCandidate: Array.from(candidates.values()).sort((a, b) => a.applywizzId.localeCompare(b.applywizzId)),
    byOperator: Array.from(operators.values()).sort((a, b) => a.email.localeCompare(b.email)),
    byDate: Array.from(dates, ([date, dateCounts]) => ({ date, counts: dateCounts })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function getBucketKeyForIstDate(isoDate: string, bucket: 'day' | 'week' | 'month'): string {
  if (bucket === 'day') return isoDate;
  if (bucket === 'month') return `${isoDate.slice(0, 7)}-01`;
  // Week: find Monday of the week for isoDate
  const [yyyy, mm, dd] = isoDate.split('-').map(Number);
  const istInstant = new Date(Date.UTC(yyyy, mm - 1, dd, 12, 0, 0));
  const istInfo = getIstCalendarDate(istInstant);
  const daysSinceMon = istInfo.dayOfWeek - 1;
  const monInstant = new Date(istInstant.getTime() - daysSinceMon * 86400000);
  return getIstCalendarDate(monInstant).isoDate;
}

export function generateTrendBucketKeys(
  fromDate: string,
  toDate: string,
  bucket: 'day' | 'week' | 'month'
): string[] {
  const dates = listIstDatesInclusive(fromDate, toDate);
  const keys = new Set<string>();
  for (const d of dates) {
    keys.add(getBucketKeyForIstDate(d, bucket));
  }
  return Array.from(keys).sort();
}

export function summarizeApplicationTrend(
  rows: ApplicationCohortRow[],
  options: {
    range: DashboardCreatedAtRange | ApplicationStatsRange;
    bucket?: 'day' | 'week' | 'month';
  }
): ApplicationTrendPoint[] {
  const bucketType = options.bucket || 'day';
  const fromDate = 'fromDate' in options.range && options.range.fromDate ? options.range.fromDate : '2026-01-01';
  const toDate = 'toDate' in options.range && options.range.toDate ? options.range.toDate : fromDate;

  const bucketKeys = generateTrendBucketKeys(fromDate, toDate, bucketType);
  const pointsMap = new Map<string, { success: number; failed: number; clientSet: Set<string> }>();

  for (const key of bucketKeys) {
    pointsMap.set(key, { success: 0, failed: 0, clientSet: new Set() });
  }

  for (const row of rows) {
    const istCreated = getIstCalendarDate(new Date(row.created_at)).isoDate;
    const key = getBucketKeyForIstDate(istCreated, bucketType);
    const point = pointsMap.get(key);
    if (!point) continue;

    if (isSuccessStatus(row.status)) {
      point.success++;
      const cid = String(row.applywizz_id || '').trim();
      if (cid) point.clientSet.add(cid);
    } else if (isFailedStatus(row.status)) {
      point.failed++;
    }
  }

  return bucketKeys.map((key) => {
    const data = pointsMap.get(key)!;
    return {
      bucketStart: key,
      successApplications: data.success,
      failedApplications: data.failed,
      clients: data.clientSet.size,
    };
  });
}

export function summarizeApplicationStatRows(rows: StatDayRow[]): {
  counts: ApplicationStatsCounts;
  byCandidate: ApplicationStatsBreakdown[];
  byOperator: OperatorStatsBreakdown[];
  byDate: DateStatsBreakdown[];
} {
  const counts = emptyCounts();
  const candidates = new Map<string, ApplicationStatsBreakdown>();
  const operators = new Map<string, OperatorStatsBreakdown>();
  const dates = new Map<string, ApplicationStatsCounts>();
  const seen = new Set<string>();
  for (const row of rows) {
    const uniqueKey = `${row.event_date}|${row.application_id}|${row.metric}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    incrementMetric(counts, row.metric);
    let dateCounts = dates.get(row.event_date);
    if (!dateCounts) {
      dateCounts = emptyCounts();
      dates.set(row.event_date, dateCounts);
    }
    incrementMetric(dateCounts, row.metric);
    let candidate = candidates.get(row.applywizz_id);
    if (!candidate) {
      candidate = { ...createBreakdown(), applywizzId: row.applywizz_id };
      candidates.set(row.applywizz_id, candidate);
    }
    incrementMetric(candidate, row.metric);
    const caEmail = row.ca_email?.trim().toLowerCase();
    if (caEmail && !candidate.caEmails.includes(caEmail)) candidate.caEmails.push(caEmail);
    if (caEmail) {
      let operator = operators.get(caEmail);
      if (!operator) {
        operator = { email: caEmail, ...emptyCounts() };
        operators.set(caEmail, operator);
      }
      incrementMetric(operator, row.metric);
    }
  }
  return {
    counts,
    byCandidate: Array.from(candidates.values()),
    byOperator: Array.from(operators.values()),
    byDate: Array.from(dates, ([date, dateCounts]) => ({ date, counts: dateCounts })),
  };
}

export function summarizeOperatorStatRows(rows: ApplicationStatFactRow[]): OperatorStatsBreakdown[] {
  const operators = new Map<string, OperatorStatsBreakdown>();
  const seen = new Set<string>();
  for (const row of rows) {
    const email = row.ca_email?.trim().toLowerCase();
    if (!email) continue;
    const uniqueKey = `${row.event_date}|${row.application_id}|${row.metric}|${email}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    let operator = operators.get(email);
    if (!operator) {
      operator = { email, ...emptyCounts() };
      operators.set(email, operator);
    }
    incrementMetric(operator, row.metric);
  }
  return Array.from(operators.values());
}

export function isApplicationStatsRangeAvailable(
  range: ApplicationStatsRange,
  availableFrom: string
): boolean {
  return range.fromDate <= range.toDate && range.toDate >= availableFrom;
}

export function effectiveApplicationStatsRange(
  range: ApplicationStatsRange,
  availableFrom: string
): { range: ApplicationStatsRange; partial: boolean } | null {
  if (!isApplicationStatsRangeAvailable(range, availableFrom)) return null;
  const partial = range.fromDate < availableFrom;
  return {
    range: { ...range, fromDate: partial ? availableFrom : range.fromDate },
    partial,
  };
}

async function resolveRangeBounds(range: DashboardCreatedAtRange | ApplicationStatsRange): Promise<{
  startIso: string;
  endIso: string | null;
  fromDate: string;
  toDate: string;
}> {
  if ('startIso' in range && range.startIso) {
    const fromDate = range.fromDate || '2000-01-01';
    const toDate = range.toDate || fromDate;
    return { startIso: range.startIso, endIso: range.endIso, fromDate, toDate };
  }
  const fromDate = range.fromDate || '2000-01-01';
  const toDate = range.toDate || fromDate;
  const { startIso } = getISTDateRangeUtc(fromDate);
  const { endIso } = getISTDateRangeUtc(toDate);
  return { startIso, endIso, fromDate, toDate };
}

export async function fetchApplicationCohortRows(options: {
  range: DashboardCreatedAtRange | ApplicationStatsRange;
  scope?: ApplicationStatsScope;
}): Promise<ApplicationCohortRow[]> {
  if (!isSupabaseConfigured()) return [];

  const { startIso, endIso } = await resolveRangeBounds(options.range);

  let allowedCaEmails: string[] | null = null;
  if (options.scope?.managerEmail) {
    const teamEmails = await listOperatorEmailsForManager(options.scope.managerEmail);
    // Strict scoping rule: empty team scope returns 0 rows, NEVER global rows
    if (teamEmails.length === 0) return [];
    if (options.scope.caEmail) {
      const target = options.scope.caEmail.trim().toLowerCase();
      if (!teamEmails.map((e) => e.toLowerCase()).includes(target)) return [];
      allowedCaEmails = [target];
    } else {
      allowedCaEmails = teamEmails.map((e) => e.toLowerCase());
    }
  } else if (options.scope?.caEmail) {
    allowedCaEmails = [options.scope.caEmail.trim().toLowerCase()];
  }

  const rows: ApplicationCohortRow[] = [];
  const pageSize = 1000;
  try {
    for (let from = 0; ; from += pageSize) {
      let query = getDbClient()
        .from('gh_candidate_applications')
        .select('id, applywizz_id, status, assigned_ca_email, created_at, first_attempted_at')
        .gte('created_at', startIso);

      if (endIso) {
        query = query.lt('created_at', endIso);
      }

      if (allowedCaEmails) {
        if (allowedCaEmails.length === 1) {
          query = query.eq('assigned_ca_email', allowedCaEmails[0]);
        } else {
          query = query.in('assigned_ca_email', allowedCaEmails);
        }
      }

      const { data, error } = await query
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) {
        log.warn(`[ApplicationStats] fetchApplicationCohortRows error: ${error.message}`);
        break;
      }
      const page = (data || []) as ApplicationCohortRow[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
  } catch (err: any) {
    log.warn(`[ApplicationStats] fetchApplicationCohortRows exception: ${err?.message || err}`);
  }

  return rows;
}

export async function getApplicationStats(options: {
  range: DashboardCreatedAtRange | ApplicationStatsRange;
  scope?: ApplicationStatsScope;
  includeBreakdown?: boolean;
}): Promise<ApplicationStatsResult> {
  if (!isSupabaseConfigured()) {
    return {
      available: true,
      partial: false,
      availableFrom: '2000-01-01',
      counts: emptyCounts(),
      byCandidate: [],
      byOperator: [],
      byDate: [],
    };
  }

  const rows = await fetchApplicationCohortRows({
    range: options.range,
    scope: options.scope,
  });

  const summary = summarizeApplicationCohortRows(rows);

  return {
    available: true,
    partial: false,
    availableFrom: '2000-01-01',
    counts: summary.counts,
    byCandidate: options.includeBreakdown ? summary.byCandidate : [],
    byOperator: options.includeBreakdown ? summary.byOperator : [],
    byDate: options.includeBreakdown ? summary.byDate : [],
  };
}

export async function getApplicationTrend(options: {
  range: DashboardCreatedAtRange | ApplicationStatsRange;
  scope?: ApplicationStatsScope;
  bucket?: 'day' | 'week' | 'month';
}): Promise<ApplicationTrendPoint[]> {
  if (!isSupabaseConfigured()) {
    const { fromDate, toDate } = await resolveRangeBounds(options.range);
    return generateTrendBucketKeys(fromDate, toDate, options.bucket || 'day').map((key) => ({
      bucketStart: key,
      successApplications: 0,
      failedApplications: 0,
      clients: 0,
    }));
  }

  const rows = await fetchApplicationCohortRows({
    range: options.range,
    scope: options.scope,
  });

  return summarizeApplicationTrend(rows, {
    range: options.range,
    bucket: options.bucket || 'day',
  });
}

export async function getManagerApplicationTotals(managerEmails: string[]): Promise<{
  available: boolean;
  availableFrom: string;
  totals: Map<string, number>;
}> {
  if (!isSupabaseConfigured()) {
    return { available: true, availableFrom: '2000-01-01', totals: new Map() };
  }

  const managers = Array.from(new Set(managerEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const entries = await Promise.all(
    managers.map(async (managerEmail) => {
      const teamEmails = await listOperatorEmailsForManager(managerEmail);
      if (teamEmails.length === 0) return [managerEmail, 0] as const;

      let query = getDbClient()
        .from('gh_candidate_applications')
        .select('id', { count: 'exact', head: true });

      if (teamEmails.length === 1) {
        query = query.eq('assigned_ca_email', teamEmails[0]);
      } else {
        query = query.in('assigned_ca_email', teamEmails);
      }

      const { count, error } = await query;
      if (error) throw new Error(`Unable to count manager applications for ${managerEmail}: ${error.message}`);
      return [managerEmail, count ?? 0] as const;
    })
  );

  return { available: true, availableFrom: '2000-01-01', totals: new Map(entries) };
}
