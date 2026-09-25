import { getDbClient } from './client.js';
import { FAILED_EQUIVALENT_STATUSES } from './applications.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Stats Rollup');

export function getIstDateString(timeMs: number): string {
  const istDate = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return `${istDate.getUTCFullYear()}-${String(istDate.getUTCMonth() + 1).padStart(2, '0')}-${String(istDate.getUTCDate()).padStart(2, '0')}`;
}

export function getIstDayBoundaries(dateStr: string): { startIso: string; endIso: string } {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function addRow(stats: RollupStats, row: { status: string; submitted_at?: string | null }, startIso: string, endIso: string): void {
  stats.total_applications += 1;
  stats.submitted_count += 1;
  if (
    (row.status === 'APPLIED' || row.status === 'EMAIL_PROOF_PENDING') &&
    row.submitted_at &&
    row.submitted_at >= startIso &&
    row.submitted_at < endIso
  ) {
    stats.applied_count += 1;
  }
  if (FAILED_EQUIVALENT_STATUSES.includes(row.status as any)) stats.failed_count += 1;
}

/**
 * Persists daily facts before clearing the working tables. Daily rows are the
 * only canonical historical grain; week/month rows are not generated because
 * mixing grains causes double counting for arbitrary dashboard ranges.
 */
export async function runStatsRollup(options?: { dailyDates?: string[] }): Promise<void> {
  const supabase = getDbClient();
  const yesterday = getIstDateString(Date.now() - 24 * 60 * 60 * 1000);
  const dailyDates = options?.dailyDates ?? [yesterday];

  for (const dateStr of dailyDates) {
    const { startIso, endIso } = getIstDayBoundaries(dateStr);
    const { data: rows, error } = await supabase
      .from('gh_candidate_applications')
      .select('status, submitted_at')
      .not('status', 'in', '(READY_FOR_REVIEW,SKIPPED)')
      .gte('created_at', startIso)
      .lt('created_at', endIso);
    if (error) throw new Error(`Failed to fetch applications for ${dateStr} rollup: ${error.message}`);

    const stats: RollupStats = {
      total_applications: 0,
      submitted_count: 0,
      applied_count: 0,
      failed_count: 0,
    };
    for (const row of rows || []) addRow(stats, row, startIso, endIso);

    const { error: upsertError } = await supabase
      .from('gh_stats_rollups')
      .upsert(
        {
          period_type: 'day',
          period_start: startIso,
          period_end: endIso,
          ...stats,
        },
        { onConflict: 'period_type,period_start' }
      );
    if (upsertError) throw new Error(`Failed to save ${dateStr} stats: ${upsertError.message}`);
    log.info(`Rolled up day ${dateStr}: ${stats.total_applications} total`);
  }

  const { data: deletedApplications, error: applicationsError } = await supabase
    .from('gh_candidate_applications')
    .delete()
    .not('id', 'is', null)
    .select('id');
  if (applicationsError) throw new Error(`Failed to prune applications: ${applicationsError.message}`);

  const { data: deletedTemplates, error: templatesError } = await supabase
    .from('gh_scanned_job_templates')
    .delete()
    .not('id', 'is', null)
    .select('id');
  if (templatesError) throw new Error(`Failed to prune templates: ${templatesError.message}`);

  log.info(`Pruned ${deletedApplications?.length || 0} applications and ${deletedTemplates?.length || 0} templates.`);
}

export interface RollupStats {
  total_applications: number;
  submitted_count: number;
  applied_count: number;
  failed_count: number;
}

/**
 * Returns exact selected-range data from daily history plus live rows that
 * have not yet been rolled up. Historical daily rows and live rows never
 * overlap after ingest cleanup.
 */
export async function queryRollupStats(startIso: string, endIso: string): Promise<RollupStats> {
  const supabase = getDbClient();
  const stats: RollupStats = {
    total_applications: 0,
    submitted_count: 0,
    applied_count: 0,
    failed_count: 0,
  };

  const { data: rollups, error: rollupError } = await supabase
    .from('gh_stats_rollups')
    .select('total_applications, submitted_count, applied_count, failed_count')
    .eq('period_type', 'day')
    .gte('period_start', startIso)
    .lt('period_start', endIso);
  if (rollupError) throw new Error(`Failed to query stats rollups: ${rollupError.message}`);

  for (const row of rollups || []) {
    stats.total_applications += Number(row.total_applications || 0);
    stats.submitted_count += Number(row.submitted_count || 0);
    stats.applied_count += Number(row.applied_count || 0);
    stats.failed_count += Number(row.failed_count || 0);
  }

  const { data: liveRows, error: liveError } = await supabase
    .from('gh_candidate_applications')
    .select('status, submitted_at')
    .not('status', 'in', '(READY_FOR_REVIEW,SKIPPED)')
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (liveError) throw new Error(`Failed to query live application stats: ${liveError.message}`);
  for (const row of liveRows || []) addRow(stats, row, startIso, endIso);

  return stats;
}
