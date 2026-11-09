import { getDbClient, isSupabaseConfigured } from './client.js';
import { getISTDateString } from '../services/workHistoryClient.js';

let cachedLatestDate: { date: string; expiresAt: number } | null = null;

export function invalidateLatestIngestRunDateCache(): void {
  cachedLatestDate = null;
}

export async function upsertIngestRun(fields: Record<string, any>): Promise<any> {
  invalidateLatestIngestRunDateCache();
  if (!isSupabaseConfigured()) return null;
  const payload = { ...fields, updated_at: new Date().toISOString() };
  const { data } = await getDbClient().from('ingest_runs').upsert(payload, { onConflict: 'id' }).select().maybeSingle();
  return data;
}

/**
 * Returns the latest calendar date (YYYY-MM-DD in IST) from the most recent ingest_run.
 * Tiered fallback:
 * 1. ingest_runs(started_at DESC) where status in ('completed', 'processing', 'running')
 * 2. gh_candidate_applications(created_at DESC)
 * 3. Current calendar IST date
 */
export async function getLatestIngestRunDate(): Promise<string> {
  const now = Date.now();
  if (cachedLatestDate && now < cachedLatestDate.expiresAt) {
    return cachedLatestDate.date;
  }

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('ingest_runs')
        .select('started_at')
        .in('status', ['completed', 'processing', 'running'])
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data?.started_at) {
        const istDate = new Date(new Date(data.started_at).getTime() + 5.5 * 3600 * 1000);
        const resolved = istDate.toISOString().slice(0, 10);
        cachedLatestDate = { date: resolved, expiresAt: now + 60 * 1000 };
        return resolved;
      }
    } catch {
      // proceed to fallback
    }

    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data?.created_at) {
        const istDate = new Date(new Date(data.created_at).getTime() + 5.5 * 3600 * 1000);
        const resolved = istDate.toISOString().slice(0, 10);
        cachedLatestDate = { date: resolved, expiresAt: now + 60 * 1000 };
        return resolved;
      }
    } catch {
      // proceed to default
    }
  }

  return getISTDateString(0);
}

