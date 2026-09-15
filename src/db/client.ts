/**
 * @fileoverview Supabase JS Client Singleton for Greenhouse Automation (V2).
 *
 * Provides a configured Supabase client using the Service Role Key to allow
 * server-side ingestion, storage uploads, and schema migrations.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import config from '../config/env.js';
import { getSupabaseKeyDiagnostics } from './supabaseKeyDiagnostics.js';

let supabaseClientInstance: SupabaseClient | null = null;

export type ResolvedSupabaseCredentials = {
  url: string;
  serviceKey: string;
  serviceKeySource: 'SUPABASE_SERVICE_KEY' | 'SUPABASE_SERVICE_ROLE_KEY' | null;
};

/**
 * Picks the server-side Supabase secret. Prefers a JWT with role service_role when
 * both SUPABASE_SERVICE_KEY (often anon by mistake) and SUPABASE_SERVICE_ROLE_KEY are set.
 */
export function resolveSupabaseCredentials(): ResolvedSupabaseCredentials {
  const url = (config.SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const candidates: Array<{
    source: ResolvedSupabaseCredentials['serviceKeySource'];
    raw: string | undefined;
  }> = [
    { source: 'SUPABASE_SERVICE_KEY', raw: config.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY },
    {
      source: 'SUPABASE_SERVICE_ROLE_KEY',
      raw: config.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
  ];

  const withRole = candidates
    .map((c) => ({ ...c, key: (c.raw || '').trim() }))
    .filter((c) => c.key.length > 0);

  const serviceRole = withRole.find(
    (c) => getSupabaseKeyDiagnostics(url, c.key).jwtRole === 'service_role'
  );
  if (serviceRole?.source && serviceRole.key) {
    return { url, serviceKey: serviceRole.key, serviceKeySource: serviceRole.source };
  }

  const first = withRole[0];
  if (first?.source && first.key) {
    return { url, serviceKey: first.key, serviceKeySource: first.source };
  }

  return { url, serviceKey: '', serviceKeySource: null };
}

/** Service role (or best available) key for server DB, Storage, and Auth admin API. */
export function getSupabaseServerApiKey(): string {
  return resolveSupabaseCredentials().serviceKey;
}

/**
 * Anon/publishable key for browser Realtime. Uses SUPABASE_ANON_KEY, or SUPABASE_SERVICE_KEY when that JWT is anon.
 */
export function resolveSupabaseAnonKey(): string {
  const url = (config.SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const explicit = (config.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (explicit) {
    return explicit;
  }
  const fromServiceKey = (config.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (fromServiceKey && getSupabaseKeyDiagnostics(url, fromServiceKey).jwtRole === 'anon') {
    return fromServiceKey;
  }
  return '';
}

/**
 * Checks whether Supabase URL and Service Key are properly configured.
 */
export function isSupabaseConfigured(): boolean {
  if (process.env.FORCE_MEMORY_DB === 'true') {
    return false;
  }
  const { url, serviceKey } = resolveSupabaseCredentials();
  return Boolean(url && serviceKey && url.startsWith('http'));
}

/** One-line safe identity log for Railway (never prints the secret). */
export function logSupabaseCredentialIdentity(context = 'Supabase'): void {
  if (!isSupabaseConfigured()) {
    console.warn(`[${context}] Supabase not configured (missing URL or service key).`);
    return;
  }
  const { url, serviceKey, serviceKeySource } = resolveSupabaseCredentials();
  const diag = getSupabaseKeyDiagnostics(url, serviceKey);
  console.log(
    `[${context}] Credential identity (${serviceKeySource ?? 'unknown env'}): ${diag.summary}`
  );
  if (diag.jwtRole && diag.jwtRole !== 'service_role') {
    console.warn(
      `[${context}] ⚠️ JWT role is "${diag.jwtRole}", not service_role — Storage listBuckets() will look empty. Set SUPABASE_SERVICE_KEY to the legacy service_role secret (eyJ…), or put it in SUPABASE_SERVICE_ROLE_KEY.`
    );
  }
  if (serviceKeySource === 'SUPABASE_SERVICE_ROLE_KEY' && diag.jwtRole === 'service_role') {
    console.log(
      `[${context}] DB/Storage using SUPABASE_SERVICE_ROLE_KEY (anon/publishable in SUPABASE_SERVICE_KEY is OK).`
    );
  }
}

/**
 * Gets or initializes the Supabase client singleton.
 * Throws an explicit error if SUPABASE_URL or SUPABASE_SERVICE_KEY are not configured.
 */
export function getDbClient(): SupabaseClient {
  if (supabaseClientInstance) {
    return supabaseClientInstance;
  }

  const { url: supabaseUrl, serviceKey: supabaseServiceKey } = resolveSupabaseCredentials();

  if (!supabaseUrl || !supabaseServiceKey || !supabaseUrl.startsWith('http')) {
    throw new Error(
      '❌ Supabase credentials missing. Set SUPABASE_URL plus SUPABASE_SERVICE_KEY and/or SUPABASE_SERVICE_ROLE_KEY (service_role JWT for server).'
    );
  }

  supabaseClientInstance = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClientInstance;
}

/**
 * Default Supabase client instance.
 * Lazily instantiated proxy to avoid runtime initialization errors before env is parsed.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getDbClient();
    const value = (client as any)[prop];
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  },
});

export default supabase;

