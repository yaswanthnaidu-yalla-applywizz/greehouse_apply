/**
 * @fileoverview Public dashboard config (non-secret keys only).
 */

import { Router, type Request, type Response } from 'express';
import config from '../../config/env.js';
import { isSupabaseConfigured } from '../../db/client.js';

export const configRouter = Router();

/**
 * GET /api/config/supabase-realtime
 * Returns Supabase URL + anon key for browser Realtime subscriptions (auth required).
 */
configRouter.get('/supabase-realtime', (_req: Request, res: Response): void => {
  const url = (config.SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const anonKey = (config.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

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
