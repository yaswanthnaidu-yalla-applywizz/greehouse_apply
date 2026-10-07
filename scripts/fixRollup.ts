import { isSupabaseConfigured } from '../src/db/client.js';
import { getApplicationStats } from '../src/db/applicationStats.js';
import { getIstDateString } from '../src/db/statsRollup.js';

async function main(): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const now = Date.now();
  const dates = [getIstDateString(now - 24 * 60 * 60 * 1000), getIstDateString(now)];
  const results = await Promise.all(
    dates.map(async (date) => ({
      date,
      ...(await getApplicationStats({ range: { fromDate: date, toDate: date } })),
    }))
  );
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to inspect application stats: ${message}`);
  process.exitCode = 1;
});
