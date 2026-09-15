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

export type SupabaseKeyCandidate = {
  source: NonNullable<ResolvedSupabaseCredentials['serviceKeySource']>;
  key: string;
};

/** Strip quotes, Bearer, and JWT/sb_* whitespace from Railway-pasted secrets. */
export function normalizeSupabaseSecret(raw: string): string {
  let k = (raw || '').trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(k)) {
    k = k.replace(/^bearer\s+/i, '').trim();
  }
  if (k.startsWith('eyJ') || k.startsWith('sb_')) {
    k = k.replace(/\s+/g, '');
  }
  return k;
}

export function createSupabaseServerClient(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function listSupabaseKeyCandidates(): { url: string; candidates: SupabaseKeyCandidate[] } {
  const url = (config.SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const raw: Array<{ source: SupabaseKeyCandidate['source']; raw: string | undefined }> = [
    { source: 'SUPABASE_SERVICE_KEY', raw: config.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY },
    {
      source: 'SUPABASE_SERVICE_ROLE_KEY',
      raw: config.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
  ];
  const seen = new Set<string>();
  const candidates: SupabaseKeyCandidate[] = [];
  for (const c of raw) {
    const key = normalizeSupabaseSecret(c.raw || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ source: c.source, key });
  }
  return { url, candidates };
}

/**
 * Picks the server-side Supabase secret. Prefers a JWT with role service_role when
 * both SUPABASE_SERVICE_KEY (often anon by mistake) and SUPABASE_SERVICE_ROLE_KEY are set.
 */
export function resolveSupabaseCredentials(): ResolvedSupabaseCredentials {
  const { url, candidates } = listSupabaseKeyCandidates();

  const serviceRoleJwt = candidates.find(
    (c) => getSupabaseKeyDiagnostics(url, c.key).jwtRole === 'service_role'
  );
  if (serviceRoleJwt) {
    return { url, serviceKey: serviceRoleJwt.key, serviceKeySource: serviceRoleJwt.source };
  }

  const roleKeyEnv = candidates.find((c) => c.source === 'SUPABASE_SERVICE_ROLE_KEY');
  if (roleKeyEnv) {
    return { url, serviceKey: roleKeyEnv.key, serviceKeySource: roleKeyEnv.source };
  }

  const first = candidates[0];
  if (first) {
    return { url, serviceKey: first.key, serviceKeySource: first.source };
  }

  return { url, serviceKey: '', serviceKeySource: null };
}

/** Swap the process-wide client after ingest finds a key that can see Storage. */
export function replaceDbClient(client: SupabaseClient): void {
  supabaseClientInstance = client;
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

  supabaseClientInstance = createSupabaseServerClient(supabaseUrl, supabaseServiceKey);

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

