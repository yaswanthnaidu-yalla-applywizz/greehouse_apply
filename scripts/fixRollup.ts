import { getDbClient, isSupabaseConfigured } from '../src/db/client.js';
import { getIstDateString, getIstDayBoundaries, runStatsRollup } from '../src/db/statsRollup.js';

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const nowMs = Date.now();
  const today = getIstDateString(nowMs);
  const yesterday = getIstDateString(nowMs - 24 * 60 * 60 * 1000);
  const periodStarts = [yesterday, today].map((date) => getIstDayBoundaries(date).startIso);

  const { error } = await getDbClient()
    .from('gh_stats_rollups')
    .delete()
    .eq('period_type', 'day')
    .in('period_start', periodStarts);

  if (error) {
    throw new Error(`Failed to delete today's and yesterday's day rollups: ${error.message}`);
  }

  console.log(`Deleted day rollups for ${yesterday} and ${today}. Recomputing...`);
  await runStatsRollup({ dailyDates: [yesterday, today] });
  console.log(`Recomputed day rollups for ${yesterday} and ${today}.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to fix stats rollups: ${message}`);
  process.exitCode = 1;
});
