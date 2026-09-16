/**
 * Dashboard users directory — scoped by role.
 */

import { Router, type Response } from 'express';
import { listAllDashboardUsers, listDashboardOperatorsForManager } from '../../db/users.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { resolveRoleFromEmail } from './auth.js';
import { hasUnrestrictedDashboardAccess, resolveRequestAppRole } from '../managerTeamScope.js';

export const usersRouter = Router();

function requestEmail(req: AuthenticatedRequest): string {
  const user = req.user as { email?: string; user_metadata?: { email?: string } } | undefined;
  return String(user?.email || user?.user_metadata?.email || '').trim().toLowerCase();
}

usersRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const email = requestEmail(req);
  const role = resolveRequestAppRole(req, email) ?? resolveRoleFromEmail(email);

  if (hasUnrestrictedDashboardAccess(role)) {
    const users = await listAllDashboardUsers();
    res.json({ users, scope: 'all' });
    return;
  }

  if (role === 'manager') {
    const users = await listDashboardOperatorsForManager(email);
    res.json({ users, scope: 'team', managerEmail: email });
    return;
  }

  res.status(403).json({ error: 'Forbidden.' });
});
