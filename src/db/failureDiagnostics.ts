import { getDbClient, isSupabaseConfigured } from './client.js';
import type {
  FailureDiagnosticRow,
  FailureDiagnosticsFilter,
} from '../types/failureDiagnostics.js';

export async function persistFailureDiagnostic(record: FailureDiagnosticRow): Promise<void> {
  if (!isSupabaseConfigured()) {
    throw new Error('Failure diagnostics storage is not configured.');
  }
  const { error } = await getDbClient().from('gh_failure_diagnostics').insert(record);
  if (error) throw error;
}

export async function listFailureDiagnostics(filters: FailureDiagnosticsFilter): Promise<{
  rows: FailureDiagnosticRow[];
  count: number;
}> {
  if (!isSupabaseConfigured()) {
    throw new Error('Failure diagnostics storage is not configured.');
  }

  let query = getDbClient()
    .from('gh_failure_diagnostics')
    .select(
      'id, phase, stage, category, reason, error_name, error_code, is_terminal, is_retryable, applywizz_id, application_id, run_id, job_url_ref, metadata, created_at',
      { count: 'exact' }
    )
    .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);

  if (filters.phase) query = query.eq('phase', filters.phase);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.applywizzId) query = query.eq('applywizz_id', filters.applywizzId.toUpperCase());
  if (filters.applicationId) query = query.eq('application_id', filters.applicationId);
  if (filters.runId) query = query.eq('run_id', filters.runId);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    rows: (data || []) as FailureDiagnosticRow[],
    count: count || 0,
  };
}

export async function countExpiredFailureDiagnostics(cutoff: string): Promise<number> {
  if (!isSupabaseConfigured()) {
    throw new Error('Failure diagnostics storage is not configured.');
  }

  let count = 0;
  let offset = 0;

  while (true) {
    const { data, error } = await getDbClient()
      .from('gh_failure_diagnostics')
      .select('id')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .range(offset, offset + 499);

    if (error) throw error;
    const batch = data || [];
    count += batch.length;
    if (batch.length < 500) return count;
    offset += batch.length;
  }
}

export async function deleteExpiredFailureDiagnostics(cutoff: string): Promise<number> {
  if (!isSupabaseConfigured()) {
    throw new Error('Failure diagnostics storage is not configured.');
  }

  let deleted = 0;

  while (true) {
    const { data: expiredRows, error: selectError } = await getDbClient()
      .from('gh_failure_diagnostics')
      .select('id')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(500);

    if (selectError) throw selectError;
    const ids = (expiredRows || []).map((row: { id: string }) => row.id);
    if (ids.length === 0) return deleted;

    const { data, error } = await getDbClient()
      .from('gh_failure_diagnostics')
      .delete()
      .in('id', ids)
      .select('id');

    if (error) throw error;
    deleted += data?.length || 0;
  }
}

export function failureDiagnosticCutoff(now = Date.now()): string {
  return new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
}
