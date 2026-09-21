import { getDbClient, isSupabaseConfigured } from './client.js';

export async function upsertIngestRun(fields: Record<string, any>): Promise<any> {
  if (!isSupabaseConfigured()) return null;
  const payload = { ...fields, updated_at: new Date().toISOString() };
  const { data } = await getDbClient().from('ingest_runs').upsert(payload, { onConflict: 'id' }).select().maybeSingle();
  return data;
}
