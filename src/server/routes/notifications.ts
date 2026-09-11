/**
 * @fileoverview Express Router for Real Application Event Notifications (Phase V2).
 *
 * Endpoints:
 * - GET /api/notifications: Returns real application status events (APPLYING, APPLIED, FAILED).
 * - DELETE /api/notifications/:id: Dismisses/removes a notification by ID or 'all'.
 */

import { Router, Request, Response } from 'express';
import {
  getRecentNotifications,
  dismissNotification,
  dismissAllNotifications,
} from '../../db/applications.js';
import { isUserAdmin } from './auth.js';
import { getCachedWorkHistory, setCachedWorkHistory } from '../workHistoryCache.js';
import { fetchWorkHistoryForDate, getYesterdayIST } from '../../services/workHistoryClient.js';
import { getAuthenticatedCaEmail } from '../workHistoryAuth.js';

export const notificationsRouter = Router();

/**
 * GET /api/notifications
 * Retrieves real application events (APPLYING, APPLIED, FAILED) optionally scoped to date and assigned candidates.
 */
notificationsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const dateParam = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : undefined;

    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin((req as any).user || userEmail);

    let allowedCandidateIds: string[] | undefined = undefined;
    if (!isAdmin) {
      if (!userEmail) {
        console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
      const targetDate = dateParam || getYesterdayIST();
      let cached = getCachedWorkHistory(userEmail, targetDate);
      if (!cached) {
        const whResult = await fetchWorkHistoryForDate(userEmail, targetDate);
        setCachedWorkHistory(userEmail, whResult.records, whResult.candidateIds, whResult.unreachable, whResult.resolvedDate, targetDate);
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      allowedCandidateIds = cached.candidateIds;
    }

    const notifications = await getRecentNotifications(limit, {
      date: dateParam,
      allowedCandidateIds,
    });
    res.json(notifications);
  } catch (err: any) {
    console.error('[Notifications Router] Failed to get notifications:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch notifications' });
  }
});

/**
 * DELETE /api/notifications/:id
 * Removes a notification from the active list. Supports :id = 'all' to clear all.
 */
notificationsRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : String(rawId || '');

  try {
    if (!id || id === 'all') {
      const current = await getRecentNotifications(100);
      dismissAllNotifications(current.map((n) => n.id));
      res.json({ success: true, cleared: 'all' });
      return;
    }

    dismissNotification(id);
    res.json({ success: true, id });
  } catch (err: any) {
    console.error(`[Notifications Router] Failed to delete notification ${id}:`, err);
    res.status(500).json({ error: err.message || 'Failed to delete notification' });
  }
});

/**
 * DELETE /api/notifications
 * Clears all notifications.
 */
notificationsRouter.delete('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const current = await getRecentNotifications(100);
    dismissAllNotifications(current.map((n) => n.id));
    res.json({ success: true, cleared: 'all' });
  } catch (err: any) {
    console.error('[Notifications Router] Failed to clear all notifications:', err);
    res.status(500).json({ error: err.message || 'Failed to clear notifications' });
  }
});
