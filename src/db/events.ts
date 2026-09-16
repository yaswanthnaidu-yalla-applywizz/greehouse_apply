/**
 * Audit + application timeline writers. Fail closed if migration 015 is not applied.
 */

import { getDbClient, isSupabaseConfigured } from './client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Events');

const missingTables = new Set<string>();

function isMissingTable(error: { message?: string; code?: string } | null | undefined, table: string): boolean {
  const message = (error?.message || '').toLowerCase();
  return error?.code === '42P01' || (message.includes(table) && message.includes('does not exist'));
}

function warnMissingOnce(table: string, error: { message?: string }): void {
  if (missingTables.has(table)) return;
  missingTables.add(table);
  log.warn(`[Events] ${table} is missing (${error.message}). Apply migration 015.`);
}

export interface AuditEventInput {
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApplicationEventInput {
  applicationId: string;
  applywizzId?: string | null;
  jobUrl?: string | null;
  fromStatus?: string | null;
  toStatus: string;
  actorEmail?: string | null;
  detail?: Record<string, unknown>;
}

async function resolveApplicationIdForEvent(event: ApplicationEventInput): Promise<string | null> {
  const trimmedId = event.applicationId?.trim();
  if (trimmedId && UUID_RE.test(trimmedId)) {
    return trimmedId;
  }
  if (!isSupabaseConfigured()) return null;

  const applywizzId = event.applywizzId?.trim();
  const jobUrl = event.jobUrl?.trim();
  if (!applywizzId || !jobUrl) return null;

  try {
    const { data, error } = await getDbClient()
      .from('candidate_applications')
      .select('id')
      .eq('applywizz_id', applywizzId)
      .eq('job_url', jobUrl)
      .maybeSingle();
    if (error) {
      log.warn(`[Events] resolve application_id failed: ${error.message}`);
      return null;
    }
    const id = data?.id ? String(data.id).trim() : '';
    return id && UUID_RE.test(id) ? id : null;
  } catch (err: any) {
    log.warn(`[Events] resolve application_id exception: ${err?.message}`);
    return null;
  }
}

export interface AuditEventRow {
  id: string;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ApplicationEventRow {
  id: string;
  application_id: string;
  applywizz_id: string | null;
  from_status: string | null;
  to_status: string;
  actor_email: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function insertAuditEvent(event: AuditEventInput): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const { error } = await getDbClient().from('audit_events').insert({
      actor_email: event.actorEmail?.trim().toLowerCase() || null,
      actor_role: event.actorRole || null,
      action: event.action,
      target_type: event.targetType || null,
      target_id: event.targetId || null,
      metadata: event.metadata || {},
    });
    if (error) {
      if (isMissingTable(error, 'audit_events')) {
        warnMissingOnce('audit_events', error);
        return;
      }
      log.warn(`[Events] audit_events insert failed: ${error.message}`);
    }
  } catch (err: any) {
    log.warn(`[Events] audit_events insert exception: ${err?.message}`);
  }
}

export async function insertApplicationEvent(event: ApplicationEventInput): Promise<void> {
  if (!isSupabaseConfigured()) {
    log.warn('[Events] application_events insert skipped: Supabase not configured.');
    return;
  }
  const resolvedId = await resolveApplicationIdForEvent(event);
  if (!resolvedId) {
    log.warn(
      `[Events] application_events insert skipped: could not resolve application_id (applywizz_id=${event.applywizzId || '—'}, job_url=${event.jobUrl || '—'}).`
    );
    return;
  }
  try {
    const { error } = await getDbClient().from('application_events').insert({
      application_id: resolvedId,
      applywizz_id: event.applywizzId || null,
      from_status: event.fromStatus || null,
      to_status: event.toStatus,
      actor_email: event.actorEmail?.trim().toLowerCase() || null,
      detail: event.detail || {},
    });
    if (error) {
      if (isMissingTable(error, 'application_events')) {
        warnMissingOnce('application_events', error);
        return;
      }
      log.warn(`[Events] application_events insert failed: ${error.message}`);
      return;
    }
    log.info(`[Events] ✅ Status change written: ${resolvedId} → ${event.toStatus}`);
  } catch (err: any) {
    log.warn(`[Events] application_events insert exception: ${err?.message}`);
  }
}

export async function listAuditEvents(options: {
  limit?: number;
  action?: string;
  actorEmail?: string;
} = {}): Promise<{ events: AuditEventRow[]; warning?: string }> {
  if (!isSupabaseConfigured()) return { events: [] };
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  try {
    let query = getDbClient()
      .from('audit_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (options.action) query = query.eq('action', options.action);
    if (options.actorEmail) query = query.eq('actor_email', options.actorEmail.trim().toLowerCase());
    const { data, error } = await query;
    if (error) {
      if (isMissingTable(error, 'audit_events')) {
        warnMissingOnce('audit_events', error);
        return { events: [], warning: 'Migration 015 not applied (audit_events).' };
      }
      throw error;
    }
    return { events: (data || []) as AuditEventRow[] };
  } catch (err: any) {
    log.warn(`[Events] listAuditEvents failed: ${err?.message}`);
    return { events: [], warning: err?.message || 'Unable to load audit events.' };
  }
}

export async function listApplicationEvents(options: {
  applicationId?: string;
  applywizzIds?: string[];
  limit?: number;
} = {}): Promise<{ events: ApplicationEventRow[]; warning?: string }> {
  if (!isSupabaseConfigured()) return { events: [] };
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  try {
    let query = getDbClient()
      .from('application_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (options.applicationId) query = query.eq('application_id', options.applicationId);
    if (options.applywizzIds && options.applywizzIds.length > 0) {
      query = query.in('applywizz_id', options.applywizzIds);
    }
    const { data, error } = await query;
    if (error) {
      if (isMissingTable(error, 'application_events')) {
        warnMissingOnce('application_events', error);
        return { events: [], warning: 'Migration 015 not applied (application_events).' };
      }
      throw error;
    }
    return { events: (data || []) as ApplicationEventRow[] };
  } catch (err: any) {
    log.warn(`[Events] listApplicationEvents failed: ${err?.message}`);
    return { events: [], warning: err?.message || 'Unable to load application events.' };
  }
}
