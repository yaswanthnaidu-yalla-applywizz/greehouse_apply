import { getDbClient } from './client.js';
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

/**
 * Application statistics are recorded transactionally by the database trigger.
 * Verify that capture is installed before pruning the working application rows.
 */
export async function runStatsRollup(): Promise<void> {
  const { data, error } = await getDbClient()
    .from('gh_stats_config')
    .select('value')
    .eq('key', 'available_from')
    .maybeSingle();
  if (error) throw new Error(`Application stats are not initialized; apply migration 027: ${error.message}`);
  if (!data?.value) throw new Error('Application stats are not initialized; apply migration 027 before pruning applications.');

  const { data: deletedApplications, error: applicationsError } = await getDbClient()
    .from('gh_candidate_applications')
    .delete()
    .not('id', 'is', null)
    .select('id');
  if (applicationsError) throw new Error(`Failed to prune applications: ${applicationsError.message}`);

  const { data: deletedTemplates, error: templatesError } = await getDbClient()
    .from('gh_scanned_job_templates')
    .delete()
    .not('id', 'is', null)
    .select('id');
  if (templatesError) throw new Error(`Failed to prune templates: ${templatesError.message}`);

  log.info(
    `Pruned ${deletedApplications?.length || 0} applications and ${deletedTemplates?.length || 0} templates; ` +
      'daily statistics are retained transactionally.'
  );
}
