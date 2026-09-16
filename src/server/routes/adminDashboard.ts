/**
 * Admin org-ops API. Strictly admin + dev (via requireRole on /api/admin).
 */

import { Router, type Request, type Response } from 'express';
import {
  countApplicationsByStatus,
  countOperatorWorkloadByProfileCaEmail,
  getISTDateRangeUtc,
  type ApplicationStatus,
} from '../../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import {
  countAuditEventsByActionInRange,
  listAuditEvents,
  SUBMIT_CLICK_AUDIT_ACTION,
} from '../../db/events.js';
import { getISTDateString } from '../../services/workHistoryClient.js';
import { emailsForRole } from './auth.js';
import { buildManagerTeamStats } from '../adminManagerStats.js';
import { loadClientDashboard } from '../clientDashboard.js';
import { listAllDashboardUsers, listOperatorEmailsForManager } from '../../db/users.js';
import { isActiveWithin, listAuthDirectory } from '../authDirectory.js';
import { collectHealthSnapshot, trafficLights } from '../healthSnapshot.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Admin Dashboard');

export const adminDashboardRouter = Router();

const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'READY_FOR_REVIEW',
  'APPROVED',
  'DRY_RUN_COMPLETE',
  'QUEUED',
  'APPLYING',
  'APPLIED',
  'FAILED',
  'EXPIRED',
  'OTP_REQUIRED',
  'CAPTCHA_TIMEOUT',
  'CAPTCHA_REQUIRED',
  'EMAIL_PROOF_PENDING',
  'EMAIL_UNVERIFIED',
  'SKIPPED',
];

function parseLimit(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

adminDashboardRouter.get('/overview', async (req: Request, res: Response): Promise<void> => {
  try {
    const dateParam = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    const date =
      dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : getISTDateString();
    const { startIso, endIso } = getISTDateRangeUtc(date);

    const directory = await listAuthDirectory();
    const managers = directory.filter((user) => user.role === 'manager');
    const mappedManagers = emailsForRole('manager');
    const managerEmails = new Set([...mappedManagers, ...managers.map((user) => user.email)]);
    const operators = directory.filter((user) => user.role === 'operator');
    const activeOperators = operators.filter((user) => isActiveWithin(user.lastSignInAt));

    const [applied, queued, applying, failed] = await Promise.all([
      countApplicationsByStatus('APPLIED'),
      countApplicationsByStatus('QUEUED'),
      countApplicationsByStatus('APPLYING'),
      countApplicationsByStatus('FAILED'),
    ]);
    const [audit, submitClicks] = await Promise.all([
      listAuditEvents({ limit: 15 }),
      countAuditEventsByActionInRange({
        action: SUBMIT_CLICK_AUDIT_ACTION,
        startIso,
        endIso,
      }),
    ]);

    res.json({
      managers: managerEmails.size,
      operators: operators.length,
      activeOperators: activeOperators.length,
      inactiveOperators: Math.max(0, operators.length - activeOperators.length),
      applicationsProcessed: applied,
      applicationsRunning: applying,
      applicationsQueued: queued,
      applicationsFailed: failed,
      submitClicks,
      submitClicksDate: date,
      recentActivity: audit.events,
      warning: audit.warning,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.error('[Admin] overview failed:', error);
    res.status(500).json({ error: 'Unable to load admin overview.' });
  }
});

adminDashboardRouter.get('/managers', async (req: Request, res: Response): Promise<void> => {
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : getISTDateString();
  try {
    const directory = await listAuthDirectory();
    const byEmail = new Map(directory.map((user) => [user.email, user]));
    const emails = Array.from(new Set([...emailsForRole('manager'), ...directory.filter((u) => u.role === 'manager').map((u) => u.email)]));

    const statsByManager = await buildManagerTeamStats(emails);
    const managers = emails.map((email) => {
      const user = byEmail.get(email);
      const stats = statsByManager.get(email) || {
        operators: 0,
        clients: 0,
        applications: 0,
        status: 'inactive' as const,
      };
      return {
        email,
        name: user?.displayName || email.split('@')[0],
        assignedOperators: stats.operators,
        assignedClients: stats.clients,
        applications: stats.applications,
        lastSignInAt: user?.lastSignInAt || null,
        status: stats.status,
      };
    });

    res.json({ date, managers });
  } catch (error) {
    log.error('[Admin] managers failed:', error);
    res.status(500).json({ error: 'Unable to load managers.' });
  }
});

adminDashboardRouter.get('/managers/:email/dashboard', async (req: Request, res: Response): Promise<void> => {
  const email = String(req.params.email || '').trim().toLowerCase();
  if (!email.includes('@')) {
    res.status(400).json({ error: 'A valid manager email is required.' });
    return;
  }
  const requestedDate = typeof req.query.date === 'string' ? req.query.date : undefined;
  if (requestedDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
    return;
  }
  const requestedCa = typeof req.query.ca === 'string' ? req.query.ca.trim() : 'all';
  try {
    const payload = await loadClientDashboard({
      managerEmail: email,
      date: requestedDate,
      ca: requestedCa,
    });
    res.json(payload);
  } catch (error) {
    log.error('[Admin] manager dashboard failed:', error);
    res.status(502).json({ error: 'Unable to load manager client table.' });
  }
});

adminDashboardRouter.get('/operators', async (req: Request, res: Response): Promise<void> => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'all';
  const managerEmail = typeof req.query.manager === 'string' ? req.query.manager.trim().toLowerCase() : '';
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : getISTDateString();

  try {
    const directory = await listAuthDirectory();
    let operators = directory.filter((user) => user.role === 'operator');
    if (search) {
      operators = operators.filter(
        (user) => user.email.includes(search) || user.displayName.toLowerCase().includes(search)
      );
    }
    if (status === 'active') operators = operators.filter((user) => isActiveWithin(user.lastSignInAt));
    if (status === 'inactive') operators = operators.filter((user) => !isActiveWithin(user.lastSignInAt));

    if (managerEmail) {
      const teamEmails = await listOperatorEmailsForManager(managerEmail);
      const teamSet = new Set(teamEmails.map((e) => e.trim().toLowerCase()));
      operators = operators.filter((user) => teamSet.has(user.email.trim().toLowerCase()));
    }

    const managerByOperatorEmail = new Map<string, string>();
    for (const row of await listAllDashboardUsers()) {
      const opEmail = (row.email || '').trim().toLowerCase();
      const mgr = (row.manager_email || '').trim().toLowerCase();
      if (opEmail && mgr) managerByOperatorEmail.set(opEmail, mgr);
    }

    const workloadByEmail = await countOperatorWorkloadByProfileCaEmail(
      operators.map((user) => user.email)
    );

    res.json({
      date,
      operators: operators.map((user) => ({
        email: user.email,
        name: user.displayName,
        managerEmail: managerByOperatorEmail.get(user.email.trim().toLowerCase()) || null,
        status:
          isActiveWithin(user.lastSignInAt) || (workloadByEmail.get(user.email) || 0) > 0
            ? 'active'
            : 'inactive',
        lastSignInAt: user.lastSignInAt,
        createdAt: user.createdAt,
        workload: workloadByEmail.get(user.email) || 0,
      })),
    });
  } catch (error) {
    log.error('[Admin] operators failed:', error);
    res.status(500).json({ error: 'Unable to load operators.' });
  }
});

adminDashboardRouter.get('/applications', async (req: Request, res: Response): Promise<void> => {
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  if (status && !APPLICATION_STATUSES.includes(status as ApplicationStatus)) {
    res.status(400).json({ error: `Unsupported application status: ${status}.` });
    return;
  }
  const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
    return;
  }
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  const limit = parseLimit(req.query.limit, 100);
  const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);

  try {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'Applications list requires Supabase.' });
      return;
    }

    let query = getDbClient()
      .from('candidate_applications')
      .select('id, applywizz_id, job_url, company_name, job_title, status, assigned_ca_email, created_at, updated_at, submitted_at, error_message, profiles!inner(client_name, ca_email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    if (date) {
      const { startIso, endIso } = getISTDateRangeUtc(date);
      query = query.gte('created_at', startIso).lte('created_at', endIso);
    }
    const { data, error, count } = await query;
    if (error) throw error;

    let rows = (data || []).map((row: any) => ({
      id: row.id,
      applywizzId: row.applywizz_id,
      client: row.profiles?.client_name || row.applywizz_id,
      jobUrl: row.job_url,
      companyName: row.company_name,
      jobTitle: row.job_title,
      status: row.status,
      operator: row.profiles?.ca_email || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submittedAt: row.submitted_at,
      errorMessage: row.error_message || '',
    }));
    if (search) {
      rows = rows.filter((row) =>
        [row.client, row.applywizzId, row.companyName, row.jobTitle, row.operator, row.jobUrl]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search))
      );
    }

    res.json({ applications: rows, total: count ?? rows.length, limit, offset });
  } catch (error) {
    log.error('[Admin] applications failed:', error);
    res.status(500).json({ error: 'Unable to load applications.' });
  }
});

adminDashboardRouter.get('/activity', async (req: Request, res: Response): Promise<void> => {
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
  const limit = parseLimit(req.query.limit, 100);
  try {
    const listed = await listAuditEvents({ limit, action: action || undefined });
    res.json(listed);
  } catch (error) {
    log.error('[Admin] activity failed:', error);
    res.status(500).json({ error: 'Unable to load audit log.' });
  }
});

adminDashboardRouter.get('/system-status', async (_req: Request, res: Response): Promise<void> => {
  try {
    const snapshot = await collectHealthSnapshot();
    res.json({
      generatedAt: snapshot.generatedAt,
      lights: trafficLights(snapshot.probes),
      queue: snapshot.queue,
      ingest: snapshot.ingest,
      workersRunning: snapshot.workers.running,
    });
  } catch (error) {
    log.error('[Admin] system-status failed:', error);
    res.status(500).json({ error: 'Unable to load system status.' });
  }
});
