import { getDbClient, isSupabaseConfigured } from './client.js';

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

export interface ApplicationStatFactRow {
  event_date: string;
  application_id: string;
  applywizz_id: string;
  metric: ApplicationStatsMetric;
  ca_email: string | null;
}
type StatDayRow = ApplicationStatFactRow;

const EMPTY_COUNTS: ApplicationStatsCounts = {
  total: 0,
  submitted: 0,
  applied: 0,
  failed: 0,
};

function emptyCounts(): ApplicationStatsCounts {
  return { ...EMPTY_COUNTS };
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
  if (status !== 'READY_FOR_REVIEW' && status !== 'SKIPPED') metrics.push('submitted');
  if (status === 'APPLIED' || status === 'EMAIL_PROOF_PENDING') metrics.push('applied');
  if (status === 'FAILED') metrics.push('failed');
  return metrics;
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

async function readStatsAvailableFrom(): Promise<string> {
  const { data, error } = await getDbClient()
    .from('gh_stats_config')
    .select('value')
    .eq('key', 'available_from')
    .maybeSingle();
  if (error) throw new Error(`Unable to read application stats availability: ${error.message}`);
  if (!data?.value || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.value))) {
    throw new Error('Application stats are not initialized; apply migration 027_application_stats_consistency.sql.');
  }
  return String(data.value);
}

export async function getManagerApplicationTotals(managerEmails: string[]): Promise<{
  available: boolean;
  availableFrom: string;
  totals: Map<string, number>;
}> {
  if (!isSupabaseConfigured()) throw new Error('Application statistics require the database and migration 027.');
  const availableFrom = await readStatsAvailableFrom();
  const istToday = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (availableFrom > istToday) {
    return { available: false, availableFrom, totals: new Map() };
  }

  const managers = Array.from(new Set(managerEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)));
  const entries = await Promise.all(managers.map(async (managerEmail) => {
    const { count, error } = await getDbClient()
      .from('gh_application_stats_daily')
      .select('application_id', { count: 'exact', head: true })
      .eq('scope_type', 'manager')
      .eq('scope_key', managerEmail)
      .eq('metric', 'total')
      .gte('event_date', availableFrom)
      .lte('event_date', istToday);
    if (error) throw new Error(`Unable to count manager application stats for ${managerEmail}: ${error.message}`);
    if (typeof count !== 'number') throw new Error(`Database did not return exact application stats for ${managerEmail}.`);
    return [managerEmail, count] as const;
  }));
  return { available: true, availableFrom, totals: new Map(entries) };
}

async function queryStatRows(
  range: ApplicationStatsRange,
  scope: { scopeType: ApplicationStatsScopeType; scopeKey: string }
): Promise<StatDayRow[]> {
  const rows: StatDayRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getDbClient()
      .from('gh_application_stats_daily')
      .select('event_date, application_id, applywizz_id, metric, ca_email')
      .eq('scope_type', scope.scopeType)
      .eq('scope_key', scope.scopeKey)
      .gte('event_date', range.fromDate)
      .lte('event_date', range.toDate)
      .order('event_date', { ascending: true })
      .order('application_id', { ascending: true })
      .order('metric', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Unable to query daily application stats: ${error.message}`);
    const page = (data || []) as StatDayRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function getApplicationStats(options: {
  range: ApplicationStatsRange;
  scope?: ApplicationStatsScope;
  includeBreakdown?: boolean;
}): Promise<ApplicationStatsResult> {
  if (!isSupabaseConfigured()) {
    throw new Error('Application statistics require the database and migration 027.');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(options.range.fromDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.range.toDate) ||
    options.range.fromDate > options.range.toDate
  ) {
    throw new Error('Application statistics require a valid inclusive IST date range.');
  }

  const availableFrom = await readStatsAvailableFrom();
  const effective = effectiveApplicationStatsRange(options.range, availableFrom);
  if (!effective) {
    return {
      available: false,
      partial: false,
      availableFrom,
      counts: { total: null, submitted: null, applied: null, failed: null },
      byCandidate: [],
      byOperator: [],
      byDate: [],
    };
  }

  const { partial, range: effectiveRange } = effective;
  const scope = resolveStatsScope(options.scope || {});
  if (!options.includeBreakdown) {
    const counts = emptyCounts();
    for (const metric of APPLICATION_STATS_METRICS) {
      const { count, error } = await getDbClient()
        .from('gh_application_stats_daily')
        .select('application_id', { count: 'exact', head: true })
        .eq('scope_type', scope.scopeType)
        .eq('scope_key', scope.scopeKey)
        .eq('metric', metric)
        .gte('event_date', effectiveRange.fromDate)
        .lte('event_date', effectiveRange.toDate);
      if (error) throw new Error(`Unable to count ${metric} application stats: ${error.message}`);
      if (typeof count !== 'number') throw new Error(`Database did not return an exact ${metric} application stats count.`);
      counts[metric] = count;
    }
    return { available: true, partial, availableFrom, counts, byCandidate: [], byOperator: [], byDate: [] };
  }

  const rows = await queryStatRows(effectiveRange, scope);
  const summary = summarizeApplicationStatRows(rows);
  let operatorRows: StatDayRow[] = [];
  if (scope.scopeType === 'manager' || scope.scopeType === 'manager_ca') {
    operatorRows = await queryStatRowsByManager(effectiveRange, scope.scopeKey, scope.scopeType === 'manager_ca');
  } else if (scope.scopeType === 'global' || scope.scopeType === 'ca') {
    operatorRows = await queryStatRowsByCa(effectiveRange, scope.scopeType === 'ca' ? scope.scopeKey : undefined);
  }

  return {
    available: true,
    partial,
    availableFrom,
    counts: summary.counts,
    byCandidate: summary.byCandidate,
    byOperator: summarizeOperatorStatRows(operatorRows),
    byDate: summary.byDate,
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

async function queryStatRowsByManager(
  range: ApplicationStatsRange,
  scopeKey: string,
  exactScope: boolean
): Promise<StatDayRow[]> {
  const rows: StatDayRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = getDbClient()
      .from('gh_application_stats_daily')
      .select('event_date, application_id, applywizz_id, metric, ca_email')
      .eq('scope_type', 'manager_ca')
      .eq('manager_email', exactScope ? scopeKey.split('|')[0] : scopeKey)
      .gte('event_date', range.fromDate)
      .lte('event_date', range.toDate)
      .order('event_date', { ascending: true })
      .order('application_id', { ascending: true })
      .order('metric', { ascending: true })
      .order('ca_email', { ascending: true });
    if (exactScope) query = query.eq('scope_key', scopeKey);
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`Unable to query operator application stats: ${error.message}`);
    const page = (data || []) as StatDayRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function queryStatRowsByCa(
  range: ApplicationStatsRange,
  caEmail?: string
): Promise<StatDayRow[]> {
  const rows: StatDayRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = getDbClient()
      .from('gh_application_stats_daily')
      .select('event_date, application_id, applywizz_id, metric, ca_email')
      .eq('scope_type', 'ca')
      .gte('event_date', range.fromDate)
      .lte('event_date', range.toDate)
      .order('event_date', { ascending: true })
      .order('application_id', { ascending: true })
      .order('metric', { ascending: true });
    if (caEmail) query = query.eq('scope_key', caEmail);
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`Unable to query operator application stats: ${error.message}`);
    const page = (data || []) as StatDayRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
