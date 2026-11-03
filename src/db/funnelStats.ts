import { getDbClient, isSupabaseConfigured } from './client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('FunnelStats');

export interface IngestFunnelStats {
  date: string;
  runId?: string;
  totalCsvRows: number;
  tasksCreated: number;
  droppedRows: number;
  dropReasons: {
    zoho_disconnected: number;
    job_expired: number;
    no_scan_template: number;
    already_applied: number;
    exclusions_or_other: number;
    [key: string]: number;
  };
  droppedDetails?: Array<{
    applywizzId: string;
    companyName: string;
    jobUrl: string;
    reason: string;
  }>;
  createdAt: string;
}

export async function saveIngestFunnelStats(
  date: string,
  stats: Omit<IngestFunnelStats, 'date' | 'createdAt'>
): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const supabase = getDbClient();
  const payload: IngestFunnelStats = {
    ...stats,
    date,
    createdAt: new Date().toISOString(),
  };

  const key = `ingest_funnel_stats:${date}`;
  const { error } = await supabase
    .from('system_config')
    .upsert({
      key,
      value: payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

  if (error) {
    log.warn(`Could not save funnel stats for ${date}: ${error.message}`);
    return false;
  }

  if (stats.runId) {
    const runKey = `ingest_funnel_stats:run:${stats.runId}`;
    await supabase.from('system_config').upsert({
      key: runKey,
      value: payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  }

  return true;
}

export async function getIngestFunnelStats(date: string): Promise<IngestFunnelStats | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getDbClient();
  const key = `ingest_funnel_stats:${date}`;
  const { data, error } = await supabase
    .from('system_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error || !data || !data.value) {
    return null;
  }

  return data.value as IngestFunnelStats;
}
