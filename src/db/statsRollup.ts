import { getDbClient } from './client.js';
import { FAILED_EQUIVALENT_STATUSES, SUBMITTED_STATUSES } from './applications.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Stats Rollup');

/**
 * Returns a strict YYYY-MM-DD string for a given epoch ms offset in IST (UTC+5:30)
 */
function getIstDateString(timeMs: number): string {
  const istDate = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the exact UTC ISO strings for 00:00:00 IST and 23:59:59.999 IST of the given date.
 */
function getIstDayBoundaries(dateStr: string): { startIso: string; endIso: string } {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * Executes the daily, weekly, and monthly rollup aggregations, and expires old ingest data.
 */
export async function runStatsRollup(): Promise<void> {
  log.info('Running stats rollup...');
  const supabase = getDbClient();
  const nowMs = Date.now();
  
  // 1. Snapshot yesterday
  const yesterdayMs = nowMs - 24 * 60 * 60 * 1000;
  const yesterdayStr = getIstDateString(yesterdayMs);
  const { startIso: yesterdayStart, endIso: yesterdayEnd } = getIstDayBoundaries(yesterdayStr);

  const { data: yesterdayRows, error: yesterdayErr } = await supabase
    .from('gh_candidate_applications')
    .select('status')
    .gte('submitted_at', yesterdayStart)
    .lt('submitted_at', yesterdayEnd);

  if (yesterdayErr) {
    log.error('Failed to fetch yesterday applications for rollup:', yesterdayErr);
    return;
  }

  let total_applications = 0;
  let submitted_count = 0;
  let applied_count = 0;
  let failed_count = 0;

  for (const row of yesterdayRows || []) {
    if (row.status === 'SKIPPED') continue; // Do not count SKIPPED in total
    total_applications++;

    if (SUBMITTED_STATUSES.includes(row.status)) {
      submitted_count++;
    }
    if (row.status === 'APPLIED' || row.status === 'EMAIL_PROOF_PENDING') {
      applied_count++;
    }
    if (FAILED_EQUIVALENT_STATUSES.includes(row.status)) {
      failed_count++;
    }
  }

  const { error: upsertDayErr } = await supabase
    .from('gh_stats_rollups')
    .upsert(
      {
        period_type: 'day',
        period_start: yesterdayStart,
        period_end: yesterdayEnd,
        total_applications,
        submitted_count,
        applied_count,
        failed_count,
      },
      { onConflict: 'period_type,period_start' }
    );

  if (upsertDayErr) {
    log.error('Failed to upsert day rollup:', upsertDayErr);
  } else {
    log.info(`Rolled up day ${yesterdayStr}: ${total_applications} total`);
  }

  // 2. Roll daily -> weekly
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const sevenDaysAgoDate = new Date(sevenDaysAgoMs).toISOString();

  const { data: dayRows, error: dayErr } = await supabase
    .from('gh_stats_rollups')
    .select('*')
    .eq('period_type', 'day')
    .lt('period_start', sevenDaysAgoDate);

  if (dayErr) {
    log.error('Failed to fetch old day rollups:', dayErr);
  } else if (dayRows && dayRows.length > 0) {
    // Group by ISO week. (Using Monday as start of week)
    const weeks = new Map<string, any[]>();
    for (const row of dayRows) {
      const d = new Date(row.period_start);
      // Convert UTC to IST to determine the week
      const istDate = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
      const day = istDate.getUTCDay() || 7; // 1-7
      const monday = new Date(Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate() - day + 1));
      const mondayStr = monday.toISOString().slice(0, 10);
      
      if (!weeks.has(mondayStr)) weeks.set(mondayStr, []);
      weeks.get(mondayStr)!.push(row);
    }

    for (const [mondayStr, rows] of weeks.entries()) {
      if (rows.length >= 7) { // Only roll up complete weeks
        const weekStartIso = getIstDayBoundaries(mondayStr).startIso;
        
        // Sunday end
        const sunday = new Date(new Date(mondayStr).getTime() + 6 * 24 * 60 * 60 * 1000);
        const weekEndIso = getIstDayBoundaries(sunday.toISOString().slice(0, 10)).endIso;

        const totals = rows.reduce(
          (acc, r) => ({
            total: acc.total + r.total_applications,
            submitted: acc.submitted + r.submitted_count,
            applied: acc.applied + r.applied_count,
            failed: acc.failed + r.failed_count,
          }),
          { total: 0, submitted: 0, applied: 0, failed: 0 }
        );

        const { error: upsertWeekErr } = await supabase.from('gh_stats_rollups').upsert({
          period_type: 'week',
          period_start: weekStartIso,
          period_end: weekEndIso,
          total_applications: totals.total,
          submitted_count: totals.submitted,
          applied_count: totals.applied,
          failed_count: totals.failed,
        }, { onConflict: 'period_type,period_start' });

        if (!upsertWeekErr) {
          const idsToDelete = rows.map((r) => r.id);
          await supabase.from('gh_stats_rollups').delete().in('id', idsToDelete);
          log.info(`Rolled up week starting ${mondayStr} (${idsToDelete.length} day rows deleted)`);
        }
      }
    }
  }

  // 3. Roll weekly -> monthly
  const twentyEightDaysAgoMs = nowMs - 28 * 24 * 60 * 60 * 1000;
  const twentyEightDaysAgoDate = new Date(twentyEightDaysAgoMs).toISOString();

  const { data: weekRows, error: weekErr } = await supabase
    .from('gh_stats_rollups')
    .select('*')
    .eq('period_type', 'week')
    .lt('period_start', twentyEightDaysAgoDate);

  if (weekErr) {
    log.error('Failed to fetch old week rollups:', weekErr);
  } else if (weekRows && weekRows.length > 0) {
    const months = new Map<string, any[]>();
    for (const row of weekRows) {
      const d = new Date(row.period_start);
      const istDate = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
      const monthStr = `${istDate.getUTCFullYear()}-${String(istDate.getUTCMonth() + 1).padStart(2, '0')}`;
      if (!months.has(monthStr)) months.set(monthStr, []);
      months.get(monthStr)!.push(row);
    }

    for (const [monthStr, rows] of months.entries()) {
      if (rows.length >= 4) { // Only roll up if we have 4+ weeks
        const monthStartIso = getIstDayBoundaries(`${monthStr}-01`).startIso;
        
        // Find last day of month
        const year = parseInt(monthStr.slice(0, 4));
        const month = parseInt(monthStr.slice(5, 7));
        const lastDay = new Date(year, month, 0).getDate();
        const monthEndIso = getIstDayBoundaries(`${monthStr}-${String(lastDay).padStart(2, '0')}`).endIso;

        const totals = rows.reduce(
          (acc, r) => ({
            total: acc.total + r.total_applications,
            submitted: acc.submitted + r.submitted_count,
            applied: acc.applied + r.applied_count,
            failed: acc.failed + r.failed_count,
          }),
          { total: 0, submitted: 0, applied: 0, failed: 0 }
        );

        const { error: upsertMonthErr } = await supabase.from('gh_stats_rollups').upsert({
          period_type: 'month',
          period_start: monthStartIso,
          period_end: monthEndIso,
          total_applications: totals.total,
          submitted_count: totals.submitted,
          applied_count: totals.applied,
          failed_count: totals.failed,
        }, { onConflict: 'period_type,period_start' });

        if (!upsertMonthErr) {
          const idsToDelete = rows.map((r) => r.id);
          await supabase.from('gh_stats_rollups').delete().in('id', idsToDelete);
          log.info(`Rolled up month ${monthStr} (${idsToDelete.length} week rows deleted)`);
        }
      }
    }
  }

  // 4. Expire monthly rows older than 1 year
  const oneYearAgoDate = new Date(nowMs - 365 * 24 * 60 * 60 * 1000).toISOString();
  const { error: deleteRollupErr } = await supabase
    .from('gh_stats_rollups')
    .delete()
    .eq('period_type', 'month')
    .lt('period_start', oneYearAgoDate);
    
  if (deleteRollupErr) log.error('Failed to expire old monthly rollups:', deleteRollupErr);

  // 5. Expire original tables
  const { data: delApp, error: delAppErr } = await supabase
    .from('gh_candidate_applications')
    .delete()
    .lt('submitted_at', yesterdayStart)
    .select('id');

  const { data: delTpl, error: delTplErr } = await supabase
    .from('gh_scanned_job_templates')
    .delete()
    .lt('updated_at', yesterdayStart)
    .select('id');

  if (delAppErr) log.error('Failed to prune old applications:', delAppErr);
  if (delTplErr) log.error('Failed to prune old templates:', delTplErr);

  log.info(`Pruned ${delApp?.length || 0} old applications and ${delTpl?.length || 0} old templates.`);
}

export interface RollupStats {
  total_applications: number;
  submitted_count: number;
  applied_count: number;
  failed_count: number;
}

/**
 * Queries rollups and live rows for a given time range.
 */
export async function queryRollupStats(startIso: string, endIso: string): Promise<RollupStats> {
  const supabase = getDbClient();
  
  // Get rolled up stats that completely fall within this range
  const { data: rollups } = await supabase
    .from('gh_stats_rollups')
    .select('total_applications, submitted_count, applied_count, failed_count')
    .gte('period_start', startIso)
    .lte('period_end', endIso);

  const stats: RollupStats = {
    total_applications: 0,
    submitted_count: 0,
    applied_count: 0,
    failed_count: 0,
  };

  for (const r of rollups || []) {
    stats.total_applications += r.total_applications;
    stats.submitted_count += r.submitted_count;
    stats.applied_count += r.applied_count;
    stats.failed_count += r.failed_count;
  }

  // To find the gap between rolled up data and the request, we determine the max period_end rolled up
  // If no rollups found, we query from startIso
  const { data: maxRollup } = await supabase
    .from('gh_stats_rollups')
    .select('period_end')
    .gte('period_start', startIso)
    .lte('period_end', endIso)
    .order('period_end', { ascending: false })
    .limit(1);

  const liveStartIso = maxRollup && maxRollup.length > 0 ? maxRollup[0].period_end : startIso;

  if (liveStartIso < endIso) {
    const { data: liveRows } = await supabase
      .from('gh_candidate_applications')
      .select('status')
      .gte('submitted_at', liveStartIso)
      .lte('submitted_at', endIso);

    for (const row of liveRows || []) {
      if (row.status === 'SKIPPED') continue;
      stats.total_applications++;
      if (SUBMITTED_STATUSES.includes(row.status)) stats.submitted_count++;
      if (row.status === 'APPLIED' || row.status === 'EMAIL_PROOF_PENDING') stats.applied_count++;
      if (FAILED_EQUIVALENT_STATUSES.includes(row.status)) stats.failed_count++;
    }
  }

  return stats;
}
