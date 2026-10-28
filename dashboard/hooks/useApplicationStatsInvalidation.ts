/**
 * @fileoverview Hook for authorized realtime stats invalidation.
 * Listens for private 'stats_changed' broadcast events (or table updates) without row payloads.
 * Automatically reconciles on visibility change, reconnect, and fallback interval.
 */

import { useEffect, useRef, useState } from 'react';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

export interface UseApplicationStatsInvalidationOptions {
  enabled?: boolean;
  apiBaseUrl?: string;
  getAuthHeaders?: () => Record<string, string>;
  onInvalidate: () => void;
}

export interface UseApplicationStatsInvalidationReturn {
  connected: boolean;
}

let cachedClient: SupabaseClient | null = null;
let cachedConfigKey = '';

async function fetchRealtimeConfig(
  apiBaseUrl: string,
  authHeaders: Record<string, string>
): Promise<{ enabled: boolean; url?: string; anonKey?: string }> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/config/supabase-realtime`, { headers: authHeaders });
    if (!res.ok) return { enabled: false };
    return (await res.json()) as { enabled: boolean; url?: string; anonKey?: string };
  } catch {
    return { enabled: false };
  }
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

export function useApplicationStatsInvalidation({
  enabled = true,
  apiBaseUrl = '',
  getAuthHeaders,
  onInvalidate,
}: UseApplicationStatsInvalidationOptions): UseApplicationStatsInvalidationReturn {
  const [connected, setConnected] = useState(false);
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;
  const getAuthHeadersRef = useRef(getAuthHeaders);
  getAuthHeadersRef.current = getAuthHeaders;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }

    let channel: RealtimeChannel | null = null;
    let cancelled = false;
    let wasConnected = false;

    // Coalesced invalidation helper
    let invalidateTimeout: ReturnType<typeof setTimeout> | null = null;
    const triggerInvalidation = () => {
      if (invalidateTimeout) return;
      invalidateTimeout = setTimeout(() => {
        invalidateTimeout = null;
        onInvalidateRef.current();
      }, 50);
    };

    // Tab visibility recovery
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        triggerInvalidation();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    // Connect to Supabase Realtime
    (async () => {
      try {
        const headers = getAuthHeadersRef.current ? getAuthHeadersRef.current() : {};
        const cfg = await fetchRealtimeConfig(apiBaseUrl, headers);
        if (cancelled || !cfg.enabled || !cfg.url || !cfg.anonKey) {
          setConnected(false);
          return;
        }

        const client = getOrCreateClient(cfg.url, cfg.anonKey);
        channel = client
          .channel('stats_invalidation', {
            config: {
              broadcast: { ack: false },
              private: true,
            },
          })
          .on('broadcast', { event: 'stats_changed' }, () => {
            triggerInvalidation();
          })
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'gh_candidate_applications' },
            (payload: any) => {
              // Ignore no-op updates where relevant cohort attributes did not change
              if (payload.eventType === 'UPDATE') {
                const o = payload.old;
                const n = payload.new;
                if (
                  o &&
                  n &&
                  o.status === n.status &&
                  o.created_at === n.created_at &&
                  o.applywizz_id === n.applywizz_id &&
                  o.assigned_ca_email === n.assigned_ca_email &&
                  o.first_attempted_at === n.first_attempted_at
                ) {
                  return;
                }
              }
              triggerInvalidation();
            }
          );

        channel.subscribe((status) => {
          if (cancelled) return;
          if (status === 'SUBSCRIBED') {
            setConnected(true);
            if (!wasConnected) {
              wasConnected = true;
              triggerInvalidation();
            }
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
            setConnected(false);
          }
        });
      } catch {
        if (!cancelled) setConnected(false);
      }
    })();

    // 5-minute reconciliation while connected; 60s fallback while disconnected
    const reconciliationInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return; // Visible-only
      }
      triggerInvalidation();
    }, 60 * 1000);

    return () => {
      cancelled = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (invalidateTimeout) clearTimeout(invalidateTimeout);
      clearInterval(reconciliationInterval);
      if (channel) {
        channel.unsubscribe();
      }
    };
  }, [enabled, apiBaseUrl]);

  return { connected };
}
