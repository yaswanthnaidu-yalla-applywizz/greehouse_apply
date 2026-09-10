/**
 * @fileoverview Supabase JS Client Singleton for Greenhouse Automation (V2).
 *
 * Provides a configured Supabase client using the Service Role Key to allow
 * server-side ingestion, storage uploads, and schema migrations.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import config from '../config/env.js';

let supabaseClientInstance: SupabaseClient | null = null;

/**
 * Checks whether Supabase URL and Service Key are properly configured.
 */
export function isSupabaseConfigured(): boolean {
  if (process.env.FORCE_MEMORY_DB === 'true') {
    return false;
  }
  const supabaseUrl = config.SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = config.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
  return Boolean(
    supabaseUrl &&
      supabaseServiceKey &&
      supabaseUrl.trim().length > 0 &&
      supabaseServiceKey.trim().length > 0 &&
      supabaseUrl.startsWith('http')
  );
}

/**
 * Gets or initializes the Supabase client singleton.
 * Throws an explicit error if SUPABASE_URL or SUPABASE_SERVICE_KEY are not configured.
 */
export function getDbClient(): SupabaseClient {
  if (supabaseClientInstance) {
    return supabaseClientInstance;
  }

  const supabaseUrl = config.SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = config.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !supabaseUrl.startsWith('http')) {
    throw new Error(
      '❌ Supabase credentials missing. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY in your .env file.'
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

