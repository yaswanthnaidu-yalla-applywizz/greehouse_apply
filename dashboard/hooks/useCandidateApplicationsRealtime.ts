/**
 * @fileoverview Supabase Realtime subscription for candidate_applications by applywizz_id or globally.
 */

import { useEffect, useRef, useCallback } from 'react';
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
  applywizzId?: string | null;
  enabled?: boolean;
  onRowChange?: (row: RealtimeApplicationRow, eventType: string) => void;
  onGlobalUpdate?: (row: RealtimeApplicationRow, eventType: string) => void;
}

export interface UseCandidateApplicationsRealtimeReturn {
  onGlobalUpdate: (callback: (row: RealtimeApplicationRow, eventType: string) => void) => void;
}

/**
 * Subscribes to postgres_changes on candidate_applications.
 * If applywizzId is provided, filters by applywizz_id.
 * If applywizzId is null/undefined, subscribes globally with no filter.
 */
export function useCandidateApplicationsRealtime(
  options: UseCandidateApplicationsRealtimeOptions
): UseCandidateApplicationsRealtimeReturn {
  const { apiBaseUrl, getAuthHeaders, applywizzId, enabled = true, onRowChange, onGlobalUpdate } = options;
  const onRowChangeRef = useRef(onRowChange);
  onRowChangeRef.current = onRowChange;
  const onGlobalUpdateRef = useRef(onGlobalUpdate);
  onGlobalUpdateRef.current = onGlobalUpdate;
  const dynamicGlobalCallbackRef = useRef<((row: RealtimeApplicationRow, eventType: string) => void) | null>(null);
  const getAuthHeadersRef = useRef(getAuthHeaders);
  getAuthHeadersRef.current = getAuthHeaders;

  const onGlobalUpdateCallback = useCallback(
    (callback: (row: RealtimeApplicationRow, eventType: string) => void) => {
      dynamicGlobalCallbackRef.current = callback;
    },
    []
  );

  useEffect(() => {
    if (!enabled) return;

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const isGlobal = !applywizzId;

    const handlePayload = (payload: { eventType: string; new: RealtimeApplicationRow }) => {
      const row = payload.new;
      if (!row || typeof row !== 'object') return;
      console.log(
        `[Realtime] candidate_applications ${payload.eventType} ${
          isGlobal ? '(global)' : `applywizz=${applywizzId}`
        } status=${String(row.status)} id=${String(row.id || '')}`
      );
      if (isGlobal) {
        if (onGlobalUpdateRef.current) {
          onGlobalUpdateRef.current(row, payload.eventType);
        }
        if (dynamicGlobalCallbackRef.current) {
          dynamicGlobalCallbackRef.current(row, payload.eventType);
        }
      }
      if (onRowChangeRef.current) {
        onRowChangeRef.current(row, payload.eventType);
      }
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
        const channelName = isGlobal
          ? 'candidate_applications:global'
          : `candidate_applications:${applywizzId}`;
        const filter = isGlobal ? undefined : `applywizz_id=eq.${applywizzId}`;

        if (filter) {
          channel = client
            .channel(channelName)
            .on(
              'postgres_changes',
              { event: 'UPDATE', schema: 'public', table: 'candidate_applications', filter },
              (payload: any) => handlePayload({ eventType: 'UPDATE', new: payload.new as RealtimeApplicationRow })
            )
            .on(
              'postgres_changes',
              { event: 'INSERT', schema: 'public', table: 'candidate_applications', filter },
              (payload: any) => handlePayload({ eventType: 'INSERT', new: payload.new as RealtimeApplicationRow })
            );
        } else {
          channel = client
            .channel(channelName)
            .on(
              'postgres_changes',
              { event: 'UPDATE', schema: 'public', table: 'candidate_applications' },
              (payload: any) => handlePayload({ eventType: 'UPDATE', new: payload.new as RealtimeApplicationRow })
            )
            .on(
              'postgres_changes',
              { event: 'INSERT', schema: 'public', table: 'candidate_applications' },
              (payload: any) => handlePayload({ eventType: 'INSERT', new: payload.new as RealtimeApplicationRow })
            );
        }

        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            console.log(
              isGlobal
                ? '[Realtime] Subscribed to candidate_applications globally'
                : `[Realtime] Subscribed to candidate_applications for ${applywizzId}`
            );
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

  return {
    onGlobalUpdate: onGlobalUpdateCallback,
  };
}

export default useCandidateApplicationsRealtime;
