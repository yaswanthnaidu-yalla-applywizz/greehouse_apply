/**
 * @fileoverview Public dashboard config (non-secret keys only).
 */

import { Router, type Request, type Response } from 'express';
import config from '../../config/env.js';
import { isSupabaseConfigured, resolveSupabaseAnonKey } from '../../db/client.js';

export const configRouter = Router();

/**
 * GET /api/config/supabase-realtime
 * Returns Supabase URL + browser key (anon/publishable) for Realtime and dashboard reads.
 * Key resolution: SUPABASE_ANON_KEY override, else SUPABASE_SERVICE_KEY (anon) when SUPABASE_SERVICE_ROLE_KEY is set.
 */
configRouter.get('/supabase-realtime', (_req: Request, res: Response): void => {
  const url = (config.SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const anonKey = resolveSupabaseAnonKey();

  if (!isSupabaseConfigured() || !url || !anonKey) {
    res.json({ enabled: false });
    return;
  }

  res.json({
    enabled: true,
    url,
    anonKey,
  });
});

export default configRouter;
