/**
 * @fileoverview Public dashboard config (non-secret keys only).
 */

import { Router, type Request, type Response } from 'express';
import config from '../../config/env.js';
import { isSupabaseConfigured, resolveSupabaseAnonKey } from '../../db/client.js';

export const configRouter = Router();

/**
 * GET /api/config/supabase-realtime
 * Returns Supabase URL + anon key for browser Realtime subscriptions (auth required).
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
