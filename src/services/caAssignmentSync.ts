/**
 * @fileoverview Service for syncing CA-to-candidate assignment mappings at ingestion time.
 * Populates profiles.ca_email and gh_candidate_applications.assigned_ca_email.
 */

import { config } from '../config/env.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { getSandboxCaEmail } from '../db/sandboxAssignment.js';
import { createLogger } from '../utils/logger.js';
import { fetchAdminWorkHistoryForDate, getISTDateString } from './workHistoryClient.js';

const log = createLogger('CaAssignmentSync');

export interface CaCandidateMapping {
  applywizzId: string;
  caEmail: string;
  clientName?: string;
}

export function parseCaMappingResponse(data: unknown): CaCandidateMapping[] {
  if (!data || typeof data !== 'object') return [];
  const root = data as Record<string, unknown>;
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.records)
        ? root.records
        : Array.isArray(root.candidates)
          ? root.candidates
          : [];

  const mappings: CaCandidateMapping[] = [];
  const seen = new Set<string>();

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;

    // Case 1: Nested CA format with `clients` array
    // e.g. { ca_email: "...", clients: [{ applywizz_id: "...", full_name: "..." }] }
    const nestedClients = Array.isArray(row.clients)
      ? row.clients
      : Array.isArray(row.assigned_clients)
        ? row.assigned_clients
        : null;

    if (nestedClients) {
      const caEmail = String(row.ca_email || row.caEmail || row.email || '').trim().toLowerCase();
      if (caEmail) {
        for (const client of nestedClients) {
          if (!client || typeof client !== 'object') continue;
          const c = client as Record<string, unknown>;
          const rawId = String(c.applywizz_id || c.applywizzId || c.id || '').trim().toUpperCase();
          const clientName = String(c.full_name || c.client_name || c.name || '').trim();
          if (rawId && !seen.has(rawId)) {
            seen.add(rawId);
            mappings.push({
              applywizzId: rawId,
              caEmail,
              ...(clientName ? { clientName } : {}),
            });
          }
        }
      }
      continue;
    }

    // Case 2: Flat mapping format
    // e.g. { applywizz_id: "...", ca_email: "..." }
    const rawId = String(row.applywizz_id || row.applywizzId || row.id || '').trim().toUpperCase();
    const rawCaEmail = String(row.ca_email || row.caEmail || row.assigned_ca_email || row.client_email || '').trim().toLowerCase();
    const clientName = String(row.client_name || row.clientName || row.full_name || row.name || '').trim();

    if (rawId && rawCaEmail && !seen.has(rawId)) {
      seen.add(rawId);
      mappings.push({
        applywizzId: rawId,
        caEmail: rawCaEmail,
        ...(clientName ? { clientName } : {}),
      });
    }
  }

  return mappings;
}

export interface CaSyncResult {
  syncedCount: number;
  source: string;
  warning?: string;
  mappingMap: Map<string, string>;
}

export async function syncCaCandidateAssignments(options: {
  force?: boolean;
  applywizzIds?: string[];
} = {}): Promise<CaSyncResult> {
  const mappingUrl = config.CA_MAPPING_API_URL?.trim();
  let mappings: CaCandidateMapping[] = [];
  let source = 'none';
  let warning: string | undefined;

  // 1. Try CA_MAPPING_API_URL if configured
  if (mappingUrl) {
    try {
      log.info(`[CaAssignmentSync] Fetching CA mapping from CA_MAPPING_API_URL: ${mappingUrl}`);
      const response = await fetch(mappingUrl, {
        signal: AbortSignal.timeout(10000),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ApplyWizz-Greenhouse-Sync/1.0',
        },
      });

      if (response.ok) {
        const json = await response.json();
        mappings = parseCaMappingResponse(json);
        source = 'ca_mapping_api';
        log.info(`[CaAssignmentSync] Fetched ${mappings.length} mappings from CA_MAPPING_API_URL`);
      } else {
        warning = `CA_MAPPING_API_URL returned HTTP ${response.status}`;
        log.warn(`[CaAssignmentSync] ${warning}`);
      }
    } catch (err: unknown) {
      warning = err instanceof Error ? err.message : String(err);
      log.warn(`[CaAssignmentSync] Failed to fetch from CA_MAPPING_API_URL: ${warning}`);
    }
  }

  // 2. Fallback to Admin Work History if no mappings resolved yet
  if (mappings.length === 0) {
    try {
      const today = getISTDateString();
      log.info(`[CaAssignmentSync] Falling back to admin work-history for date=${today}`);
      const whResult = await fetchAdminWorkHistoryForDate(today);
      if (!whResult.unreachable && whResult.records.length > 0) {
        mappings = whResult.records.map((r) => ({
          applywizzId: r.applywizzId.toUpperCase(),
          caEmail: r.clientEmail.toLowerCase(),
          clientName: r.clientName,
        }));
        source = 'work_history_fallback';
        log.info(`[CaAssignmentSync] Resolved ${mappings.length} mappings from admin work history`);
      } else if (whResult.unreachable) {
        warning = warning || 'Work history fallback was unreachable';
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warning = warning ? `${warning}; Work history error: ${msg}` : msg;
      log.warn(`[CaAssignmentSync] Work history fallback failed: ${msg}`);
    }
  }

  const sandboxCaEmail = getSandboxCaEmail();
  const mappingMap = new Map<string, string>();
  for (const item of mappings) {
    const email = sandboxCaEmail ? sandboxCaEmail.trim().toLowerCase() : item.caEmail.trim().toLowerCase();
    mappingMap.set(item.applywizzId.toUpperCase(), email);
  }

  if (mappings.length === 0 || !isSupabaseConfigured()) {
    return { syncedCount: 0, source, warning, mappingMap };
  }

  // 3. Persist mappings to database
  const supabase = getDbClient();
  let syncedCount = 0;

  const targetIdSet = options.applywizzIds && options.applywizzIds.length > 0
    ? new Set(options.applywizzIds.map((id) => (id || '').trim().toUpperCase()).filter(Boolean))
    : null;

  const itemsToPersist = targetIdSet
    ? mappings.filter((item) => targetIdSet.has(item.applywizzId.toUpperCase()))
    : mappings;

  const CHUNK_SIZE = 10;
  for (let i = 0; i < itemsToPersist.length; i += CHUNK_SIZE) {
    const chunk = itemsToPersist.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (item) => {
        const caEmail = sandboxCaEmail ? sandboxCaEmail.trim().toLowerCase() : item.caEmail;
        try {
          // A. Update profile ca_email
          await supabase
            .from('profiles')
            .update({ ca_email: caEmail, updated_at: new Date().toISOString() })
            .eq('applywizz_id', item.applywizzId);

          // B. Stamp assigned_ca_email on gh_candidate_applications
          await supabase
            .from('gh_candidate_applications')
            .update({ assigned_ca_email: caEmail })
            .eq('applywizz_id', item.applywizzId);

          syncedCount++;
        } catch (err) {
          log.warn(`[CaAssignmentSync] Failed persisting mapping for ${item.applywizzId}:`, err);
        }
      })
    );
  }

  log.info(`[CaAssignmentSync] Successfully synced ${syncedCount} CA mappings (source=${source})`);
  return { syncedCount, source, warning, mappingMap };
}
