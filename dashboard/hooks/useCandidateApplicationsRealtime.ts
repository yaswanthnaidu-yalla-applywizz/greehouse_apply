/**
 * @fileoverview Supabase Realtime subscription for candidate_applications by applywizz_id.
 */

import { useEffect, useRef } from 'react';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { RealtimeApplicationRow } from '../../src/dashboard/applicationRealtimeMerge.js';

export interface SupabaseRealtimeConfig {
  enabled: boolean;
  url?: string;
  anonKey?: string;
}

let cachedClient: SupabaseClient | null = null;
let cachedConfigKey = '';

async function fetchRealtimeConfig(apiBaseUrl: string, authHeaders: Record<string, string>): Promise<SupabaseRealtimeConfig> {
  const res = await fetch(`${apiBaseUrl}/api/config/supabase-realtime`, { headers: authHeaders });
  if (!res.ok) return { enabled: false };
  return (await res.json()) as SupabaseRealtimeConfig;
}

function getOrCreateClient(url: string, anonKey: string): SupabaseClient {
  const key = `${url}::${anonKey.slice(0, 8)}`;
  if (cachedClient && cachedConfigKey === key) {
    return cachedClient;
  }
  cachedClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  cachedConfigKey = key;
  return cachedClient;
}

export interface UseCandidateApplicationsRealtimeOptions {
  apiBaseUrl: string;
  getAuthHeaders: () => Record<string, string>;
  applywizzId: string | null;
  enabled: boolean;
  onRowChange: (row: RealtimeApplicationRow, eventType: string) => void;
}

/**
 * Subscribes to postgres_changes on candidate_applications filtered by applywizz_id.
 */
export function useCandidateApplicationsRealtime(options: UseCandidateApplicationsRealtimeOptions): void {
  const { apiBaseUrl, getAuthHeaders, applywizzId, enabled, onRowChange } = options;
  const onRowChangeRef = useRef(onRowChange);
  onRowChangeRef.current = onRowChange;
  const getAuthHeadersRef = useRef(getAuthHeaders);
  getAuthHeadersRef.current = getAuthHeaders;

  useEffect(() => {
    if (!enabled || !applywizzId) return;

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const handlePayload = (payload: { eventType: string; new: RealtimeApplicationRow }) => {
      const row = payload.new;
      if (!row || typeof row !== 'object') return;
      console.log(
        `[Realtime] candidate_applications ${payload.eventType} applywizz=${applywizzId} status=${String(row.status)} id=${String(row.id || '')}`
      );
      onRowChangeRef.current(row, payload.eventType);
    };

    (async () => {
      try {
        const cfg = await fetchRealtimeConfig(apiBaseUrl, getAuthHeadersRef.current());
        if (cancelled || !cfg.enabled || !cfg.url || !cfg.anonKey) {
          if (!cfg.enabled) {
            console.warn('[Realtime] Supabase Realtime not configured (missing SUPABASE_ANON_KEY).');
          }
          return;
        }

        const client = getOrCreateClient(cfg.url, cfg.anonKey);
        const filter = `applywizz_id=eq.${applywizzId}`;

        channel = client
          .channel(`candidate_applications:${applywizzId}`)
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'candidate_applications', filter },
            (payload) => handlePayload({ eventType: 'UPDATE', new: payload.new as RealtimeApplicationRow })
          )
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'candidate_applications', filter },
            (payload) => handlePayload({ eventType: 'INSERT', new: payload.new as RealtimeApplicationRow })
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              console.log(`[Realtime] Subscribed to candidate_applications for ${applywizzId}`);
            }
          });
      } catch (err) {
        console.warn('[Realtime] Failed to subscribe:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (channel) {
        channel.unsubscribe();
      }
    };
  }, [apiBaseUrl, applywizzId, enabled]);
}
