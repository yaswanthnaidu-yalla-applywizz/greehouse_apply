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
import { istDatesForWorkHistory, parseDashboardCreatedAtRange } from '../dashboardDateRange.js';
import { mergeWorkHistoryForIstDates } from '../workHistorySpan.js';
import { getAuthenticatedCaEmail } from '../workHistoryAuth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { resolveManagerViewAsOperatorScope, resolveViewAsOperatorManagerEmail } from '../managerTeamScope.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Notifications');

export const notificationsRouter = Router();

/**
 * GET /api/notifications
 * Retrieves real application events (APPLYING, APPLIED, FAILED) optionally scoped to date and assigned candidates.
 */
notificationsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }

    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin((req as any).user || userEmail);
    const viewAsManagerEmail = resolveViewAsOperatorManagerEmail(req as AuthenticatedRequest);
    const adminBypass = isAdmin && !viewAsManagerEmail;

    let allowedCandidateIds: string[] | undefined = undefined;
    if (!adminBypass) {
      if (!userEmail && !viewAsManagerEmail) {
        log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
      if (viewAsManagerEmail) {
        const scope = await resolveManagerViewAsOperatorScope(viewAsManagerEmail);
        allowedCandidateIds = Array.from(scope.allowedIds);
      } else {
        const merged = await mergeWorkHistoryForIstDates({
          mode: 'ca',
          caEmail: userEmail!,
          dates: istDatesForWorkHistory(parsedRange),
        });
        allowedCandidateIds = merged.candidateIds;
      }
    }

    const notifications = await getRecentNotifications(limit, {
      createdAtRange: { startIso: parsedRange.startIso, endIso: parsedRange.endIso },
      allowedCandidateIds,
    });
    res.json(notifications);
  } catch (err: any) {
    log.error('[Notifications Router] Failed to get notifications:', err);
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
    log.error(`[Notifications Router] Failed to delete notification ${id}:`, err);
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
    log.error('[Notifications Router] Failed to clear all notifications:', err);
    res.status(500).json({ error: err.message || 'Failed to clear notifications' });
  }
});
