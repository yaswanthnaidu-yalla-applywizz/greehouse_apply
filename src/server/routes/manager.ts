/**
 * Manager dashboard API.
 * Team scoping via careerassociatemanager_id is currently off
 * (`MANAGER_TEAM_SCOPE_ENABLED` in clientDashboard.ts).
 * Admins do not use these routes; they have /api/admin.
 */

import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  applyCreatedAtRangeFilter,
  getISTDateRangeUtc,
  countCompletedApplicationsSince,
  listApplications,
  rowCreatedAtInRange,
  type ApplicationRow,
  type ApplicationStatus,
} from '../../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { insertAuditEvent, listApplicationEvents, type ApplicationEventRow } from '../../db/events.js';
import { getISTDateString } from '../../services/workHistoryClient.js';
import { canAccessManagerDashboard, resolveRole } from './auth.js';
import { loadClientDashboard, MANAGER_TEAM_SCOPE_ENABLED } from '../clientDashboard.js';
import { listAllDashboardUsers, listOperatorEmailsForManager } from '../../db/users.js';
import { distinctApplywizzIdsForOperatorEmails, hasUnrestrictedDashboardAccess, resolveRequestAppRole } from '../managerTeamScope.js';
import { parseDashboardCreatedAtRange, serializeDateRange } from '../dashboardDateRange.js';
import { displayNameMapForEmails, isActiveWithin, listAuthDirectory } from '../authDirectory.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Manager');

export const managerRouter = Router();

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
];

function getAuthenticatedEmail(req: Request): string {
  const user = (req as AuthenticatedRequest).user as { email?: string; user_metadata?: { email?: string } } | undefined;
  return String(user?.email || user?.user_metadata?.email || '').trim().toLowerCase();
}

function requireManager(req: Request, res: Response): boolean {
  const authReq = req as AuthenticatedRequest;
  if (!canAccessManagerDashboard(authReq.user || getAuthenticatedEmail(req))) {
    res.status(403).json({ error: 'Manager access is required.' });
    return false;
  }
  return true;
}

function managerEmailForRequest(req: Request): string {
  const self = getAuthenticatedEmail(req);
  const role = resolveRole((req as AuthenticatedRequest).user || self);
  const impersonate =
    typeof req.query.managerEmail === 'string' ? req.query.managerEmail.trim().toLowerCase() : '';
  if (role === 'dev' && impersonate) return impersonate;
  return self;
}

function serializeManagerApplication(application: ApplicationRow) {
  return {
    ...application,
    applywizzId: application.applywizz_id,
    jobUrl: application.job_url,
    companyName: application.company_name ?? null,
    jobTitle: application.job_title ?? null,
    hasManualEdits: Boolean(application.has_manual_edits),
  };
}

function parseLimit(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

interface ManagerActivityEvent {
  timestamp: string;
  candidate_name: string;
  job_title: string;
  company_name: string;
  from_status: string | null;
  to_status: string;
  applywizz_id: string;
}

function profileDisplayName(row: {
  client_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const clientName = (row.client_name || '').trim();
  if (clientName) return clientName;
  const combined = `${row.first_name || ''} ${row.last_name || ''}`.trim();
  return combined;
}

async function enrichApplicationEventsForActivity(
  rawEvents: ApplicationEventRow[]
): Promise<ManagerActivityEvent[]> {
  if (rawEvents.length === 0) return [];

  const appIds = [...new Set(rawEvents.map((e) => e.application_id).filter(Boolean))];
  const applywizzIdsFromEvents = [
    ...new Set(rawEvents.map((e) => (e.applywizz_id || '').trim()).filter(Boolean)),
  ];

  type AppJoinRow = {
    id: string;
    job_url: string | null;
    applywizz_id: string;
    job_title: string | null;
    company_name: string | null;
  };
  const appById = new Map<string, AppJoinRow>();
  const profileByAwl = new Map<
    string,
    { client_name: string | null; first_name: string | null; last_name: string | null }
  >();
  const templateByJobUrl = new Map<
    string,
    { job_title: string | null; company_name: string | null }
  >();

  if (isSupabaseConfigured()) {
    if (appIds.length > 0) {
      const { data: apps, error: appsError } = await getDbClient()
        .from('gh_candidate_applications')
        .select('id, job_url, applywizz_id, job_title, company_name')
        .in('id', appIds);
      if (appsError) {
        log.warn(`[Manager Router] activity application join failed: ${appsError.message}`);
      } else {
        for (const row of apps || []) {
          appById.set(String(row.id), row as AppJoinRow);
        }
      }
    }

    const applywizzIds = [
      ...new Set([
        ...applywizzIdsFromEvents,
        ...Array.from(appById.values()).map((a) => (a.applywizz_id || '').trim()).filter(Boolean),
      ]),
    ];
    if (applywizzIds.length > 0) {
      const { data: profiles, error: profilesError } = await getDbClient()
        .from('profiles')
        .select('applywizz_id, client_name, first_name, last_name')
        .in('applywizz_id', applywizzIds);
      if (profilesError) {
        log.warn(`[Manager Router] activity profile join failed: ${profilesError.message}`);
      } else {
        for (const row of profiles || []) {
          const key = String(row.applywizz_id || '').trim();
          if (key) profileByAwl.set(key, row);
        }
      }
    }

    const jobUrls = [
      ...new Set(
        Array.from(appById.values())
          .map((a) => (a.job_url || '').trim())
          .filter(Boolean)
      ),
    ];
    if (jobUrls.length > 0) {
      const { data: templates, error: templatesError } = await getDbClient()
        .from('gh_scanned_job_templates')
        .select('job_url, job_title, company_name')
        .in('job_url', jobUrls);
      if (templatesError) {
        log.warn(`[Manager Router] activity template join failed: ${templatesError.message}`);
      } else {
        for (const row of templates || []) {
          const key = String(row.job_url || '').trim();
          if (key) templateByJobUrl.set(key, row);
        }
      }
    }
  }

  return rawEvents.map((event) => {
    const app = appById.get(event.application_id);
    const applywizz_id = (event.applywizz_id || app?.applywizz_id || '').trim() || '—';
    const profile = applywizz_id !== '—' ? profileByAwl.get(applywizz_id) : undefined;
    const candidate_name =
      (profile && profileDisplayName(profile)) || applywizz_id || '—';

    const jobUrl = (app?.job_url || '').trim();
    const template = jobUrl ? templateByJobUrl.get(jobUrl) : undefined;
    const job_title =
      (template?.job_title || app?.job_title || '').trim() || 'Job';
    const company_name =
      (template?.company_name || app?.company_name || '').trim() || '—';

    return {
      timestamp: event.created_at,
      candidate_name,
      job_title,
      company_name,
      from_status: event.from_status,
      to_status: event.to_status,
      applywizz_id,
    };
  });
}

async function scopedApplywizzIds(req: Request): Promise<{
  ids: string[] | null;
  operatorEmails: string[] | null;
  warning?: string;
  managerEmail: string;
}> {
  const managerEmail = managerEmailForRequest(req);
  const role = resolveRequestAppRole(req as AuthenticatedRequest, managerEmail);
  if (!MANAGER_TEAM_SCOPE_ENABLED || hasUnrestrictedDashboardAccess(role)) {
    return { ids: null, operatorEmails: null, managerEmail };
  }
  const operatorEmails = await listOperatorEmailsForManager(managerEmail);
  if (operatorEmails.length === 0) {
    return {
      ids: [],
      operatorEmails: [],
      managerEmail,
      warning: 'No operators are assigned to this manager yet.',
    };
  }
  const ids = await distinctApplywizzIdsForOperatorEmails(operatorEmails);
  return { ids, operatorEmails, managerEmail };
}

function inScope(application: Pick<ApplicationRow, 'applywizz_id'>, ids: string[] | null): boolean {
  if (ids === null) return true;
  const idSet = new Set(ids.map((id) => id.trim().toUpperCase()));
  return idSet.has(application.applywizz_id.trim().toUpperCase());
}

managerRouter.get('/dashboard', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  const managerEmail = managerEmailForRequest(req);
  if (!managerEmail) {
    res.status(401).json({ error: 'Authenticated manager email is required.' });
    return;
  }

  const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
  if ('error' in parsedRange) {
    res.status(400).json({ error: parsedRange.error });
    return;
  }
  const requestedCa = typeof req.query.ca === 'string' ? req.query.ca.trim() : 'all';

  try {
    const role = resolveRequestAppRole(req as AuthenticatedRequest, managerEmail);
    const unrestricted = hasUnrestrictedDashboardAccess(role);
    const payload = await loadClientDashboard({
      managerEmail,
      date: parsedRange.fromDate || parsedRange.toDate || getISTDateString(),
      createdAtRange: { startIso: parsedRange.startIso, endIso: parsedRange.endIso },
      dateRangeMeta: serializeDateRange(parsedRange),
      ca: requestedCa,
      teamScopeUnrestricted: unrestricted,
    });
    const operatorEmails = unrestricted
      ? undefined
      : await listOperatorEmailsForManager(managerEmail);
    const completed = await countCompletedApplicationsSince(
      getISTDateRangeUtc(getISTDateString()).startIso,
      operatorEmails
    );
    const { waiting_for_email: _waitingForEmail, ...totalsWithoutWaiting } = payload.totals;
    res.json({
      ...payload,
      totalApplications: payload.totals.applications,
      totals: totalsWithoutWaiting,
      completed,
      rows: payload.rows.map((row) => ({
        ...row,
        waiting_for_email: undefined,
        assigned_ca: (row.assigned_ca || '').trim(),
      })),
    });
  } catch (error) {
    log.error('[Manager Router] Failed to load dashboard:', error);
    res.status(502).json({ error: 'Unable to load manager dashboard.' });
  }
});

managerRouter.get('/operators', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;
  const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
  if ('error' in parsedRange) {
    res.status(400).json({ error: parsedRange.error });
    return;
  }
  const date = parsedRange.fromDate || parsedRange.toDate || getISTDateString();

  try {
    const managerEmail = managerEmailForRequest(req);
    const role = resolveRequestAppRole(req as AuthenticatedRequest, managerEmail);
    const unrestricted = hasUnrestrictedDashboardAccess(role);
    const dashboard = await loadClientDashboard({
      managerEmail,
      date,
      createdAtRange: { startIso: parsedRange.startIso, endIso: parsedRange.endIso },
      dateRangeMeta: serializeDateRange(parsedRange),
      teamScopeUnrestricted: unrestricted,
    });
    const directory = await listAuthDirectory();
    const byEmail = new Map(directory.map((user) => [user.email, user]));
    let inFlightRows: Array<{ assigned_ca_email?: string | null }> = [];
    if (isSupabaseConfigured()) {
      const { data, error } = await getDbClient()
        .from('gh_candidate_applications')
        .select('assigned_ca_email')
        .in('status', ['QUEUED', 'APPLYING']);
      if (!error && data) {
        inFlightRows = data;
      }
    } else {
      const [queued, applying] = await Promise.all([
        listApplications({ status: 'QUEUED' }),
        listApplications({ status: 'APPLYING' }),
      ]);
      inFlightRows = [...queued, ...applying];
    }
    const inFlight = new Set(
      inFlightRows
        .map((row) => (row.assigned_ca_email || '').trim().toLowerCase())
        .filter(Boolean)
    );

const operators = new Map<
       string,
       { email: string; name: string; applications: number; completed: number; applied: number; pending: number; failed: number }
     >();
    for (const row of dashboard.rows) {
       const email = (row.assignedToEmail || '').trim().toLowerCase();
      if (!email) continue;
const current = operators.get(email) || {
       email,
       name: row.assignedTo,
       applications: 0,
       completed: 0,
       applied: 0,
       pending: 0,
       failed: 0,
     };
current.applications += row.applications;
       current.completed += row.completed;
       current.applied += row.applied;
       current.pending += row.pending;
       current.failed += row.failed;
      operators.set(email, current);
    }

    if (unrestricted) {
      const registered = await listAllDashboardUsers();
      for (const user of registered) {
        if ((user.role || '').trim().toLowerCase() !== 'operator') continue;
        const email = user.email.trim().toLowerCase();
        if (!email || operators.has(email)) continue;
operators.set(email, {
           email,
           name: user.name || email.split('@')[0],
           applications: 0,
           completed: 0,
           applied: 0,
           pending: 0,
           failed: 0,
         });
      }
      for (const user of directory) {
        const email = (user.email || '').trim().toLowerCase();
        if (!email || operators.has(email)) continue;
        if (user.role !== 'operator') continue;
operators.set(email, {
           email,
           name: user.displayName || email.split('@')[0],
           applications: 0,
           completed: 0,
           applied: 0,
           pending: 0,
           failed: 0,
         });
      }
    }

    

const items = Array.from(operators.values()).map((operator) => {
       const user = byEmail.get(operator.email);
       const active = isActiveWithin(user?.lastSignInAt) || inFlight.has(operator.email);
       return {
         email: operator.email,
         name: operator.name,
         status: active ? 'active' : 'inactive',
         applications: operator.applications,
         completed: operator.completed,
         applied: operator.applied,
         pending: operator.pending,
         failed: operator.failed,
         lastSignInAt: user?.lastSignInAt || null,
       };
     });

    res.json({
      date,
      dateRange: serializeDateRange(parsedRange),
      operators: items,
      totals: {
        assigned: items.reduce((total, item) => total + item.applications, 0),
        completed: items.reduce((total, item) => total + item.completed, 0),
        applied: items.reduce((total, item) => total + item.applied, 0),
        active: items.filter((item) => item.status === 'active').length,
        inactive: items.filter((item) => item.status === 'inactive').length,
      },
      warning: dashboard.warning,
    });
  } catch (error) {
    log.error('[Manager Router] Failed to load operators:', error);
    res.status(500).json({ error: 'Unable to load manager operators.' });
  }
});

managerRouter.get('/activity', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;
  const limit = parseLimit(req.query.limit, 100);
  try {
    const scoped = await scopedApplywizzIds(req);
    if (scoped.ids && scoped.ids.length === 0) {
      res.json({ events: [], warning: scoped.warning || 'No clients linked to this manager.' });
      return;
    }
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const listed = await listApplicationEvents({
      applywizzIds: scoped.ids || undefined,
      limit,
      startIso: parsedRange.startIso,
      endIso: parsedRange.endIso,
    });
    const events = await enrichApplicationEventsForActivity(listed.events);
    res.json({
      events,
      warning: listed.warning || scoped.warning,
    });
  } catch (error) {
    log.error('[Manager Router] Failed to load activity:', error);
    res.status(500).json({ error: 'Unable to load team activity.' });
  }
});

managerRouter.get('/reports', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;
  const range = typeof req.query.range === 'string' ? req.query.range.trim().toLowerCase() : 'daily';
  if (!['daily', 'weekly', 'monthly'].includes(range)) {
    res.status(400).json({ error: 'range must be daily, weekly, or monthly.' });
    return;
  }

  try {
    const scoped = await scopedApplywizzIds(req);
    if (!isSupabaseConfigured() || (scoped.ids && scoped.ids.length === 0)) {
      res.json({ range, buckets: [], perOperator: [], warning: scoped.warning });
      return;
    }

    const dayCount = range === 'monthly' ? 180 : range === 'weekly' ? 56 : 14;
    const end = getISTDateString();
    const startDate = new Date(`${end}T00:00:00+05:30`);
    startDate.setDate(startDate.getDate() - (dayCount - 1));
    const start = startDate.toISOString().slice(0, 10);
    const { startIso } = getISTDateRangeUtc(start);
    const { endIso } = getISTDateRangeUtc(end);

    let query = getDbClient()
      .from('gh_candidate_applications')
      .select('created_at, assigned_ca_email, applywizz_id')
      .gte('created_at', startIso)
      .lte('created_at', endIso);
    if (scoped.ids) query = query.in('applywizz_id', scoped.ids);
    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const bucketMap = new Map<string, number>();
    const operatorMap = new Map<string, number>();
    for (const row of rows) {
      const created = row.created_at ? new Date(row.created_at) : null;
      if (!created) continue;
      const ist = new Date(created.getTime() + 5.5 * 60 * 60 * 1000);
      let key = ist.toISOString().slice(0, 10);
      if (range === 'weekly') {
        const week = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
        const day = week.getUTCDay() || 7;
        week.setUTCDate(week.getUTCDate() - day + 1);
        key = week.toISOString().slice(0, 10);
      } else if (range === 'monthly') {
        key = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      bucketMap.set(key, (bucketMap.get(key) || 0) + 1);
      const email = String(row.assigned_ca_email || '').trim().toLowerCase();
      if (email) operatorMap.set(email, (operatorMap.get(email) || 0) + 1);
    }

    const names = await displayNameMapForEmails(Array.from(operatorMap.keys()));
    const perOperator = await Promise.all(
      Array.from(operatorMap.entries())
        .sort((a, b) => b[1] - a[1])
        .map(async ([email, applications]) => {
          const completed = await countCompletedApplicationsSince(startIso, [email]);
          return {
            email,
            name: names.get(email) || email.split('@')[0],
            applications,
            apps: applications,
            completed,
            approved: completed,
          };
        })
    );
    res.json({
      range,
      start,
      end,
      buckets: Array.from(bucketMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, applications]) => ({ date, applications })),
      perOperator,
      warning: scoped.warning,
    });
  } catch (error) {
    log.error('[Manager Router] Failed to load reports:', error);
    res.status(500).json({ error: 'Unable to load manager reports.' });
  }
});

managerRouter.get(['/overview', '/stats'], async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
  if ('error' in parsedRange) {
    res.status(400).json({ error: parsedRange.error });
    return;
  }
  const createdAtRange = { startIso: parsedRange.startIso, endIso: parsedRange.endIso };

  try {
    const scoped = await scopedApplywizzIds(req);
    let applications: Array<Pick<ApplicationRow, 'id' | 'applywizz_id' | 'status' | 'created_at'>> = [];
    if (isSupabaseConfigured()) {
      let query = getDbClient()
        .from('gh_candidate_applications')
        .select('id, applywizz_id, status, created_at');
      if (scoped.ids) query = query.in('applywizz_id', scoped.ids);
      query = applyCreatedAtRangeFilter(query, createdAtRange);
      const { data, error } = await query;
      if (!error && data) {
        applications = (data as Array<Pick<ApplicationRow, 'id' | 'applywizz_id' | 'status' | 'created_at'>>)
          .filter((application) => inScope(application as ApplicationRow, scoped.ids));
      }
    } else {
      const allApps =
        scoped.ids && scoped.ids.length === 1
          ? await listApplications({ applywizzId: scoped.ids[0] })
          : await listApplications();
      applications = allApps
        .filter((application) => inScope(application, scoped.ids))
        .filter((application) => rowCreatedAtInRange(application, createdAtRange));
    }
    const statusCounts: Record<string, number> = {};
    for (const status of APPLICATION_STATUSES) {
      statusCounts[status] = applications.filter((application) => application.status === status).length;
    }
    const candidateIds = new Set(applications.map((application) => application.applywizz_id));

    res.json({
      candidates: candidateIds.size,
      applications: applications.length,
      dateRange: serializeDateRange(parsedRange),
      statusCounts,
      queue: {
        queued: statusCounts.QUEUED ?? 0,
        applying: statusCounts.APPLYING ?? 0,
        otpRequired: statusCounts.OTP_REQUIRED ?? 0,
      },
      outcomes: {
        applied: statusCounts.APPLIED ?? 0,
        failed: statusCounts.FAILED ?? 0,
      },
      warning: scoped.warning,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.error('[Manager Router] Failed to load overview:', error);
    res.status(500).json({ error: 'Unable to load manager overview.' });
  }
});

managerRouter.get('/applications', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status && !APPLICATION_STATUSES.includes(status as ApplicationStatus)) {
    res.status(400).json({ error: `Unsupported application status: ${status}.` });
    return;
  }

  const applywizzId =
    typeof req.query.applywizzId === 'string'
      ? req.query.applywizzId
      : typeof req.query.applywizz_id === 'string'
        ? req.query.applywizz_id
        : undefined;
  const limit = parseLimit(req.query.limit);
  const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);

  try {
    const scoped = await scopedApplywizzIds(req);
    if (applywizzId && scoped.ids && !inScope({ applywizz_id: applywizzId }, scoped.ids)) {
      res.json({ applications: [], total: 0, limit, offset, warning: 'Candidate is not on this manager team.' });
      return;
    }
    const applications = (await listApplications({
      status: status as ApplicationStatus | undefined,
      applywizzId,
    })).filter((application) => inScope(application, scoped.ids));
    const page = applications.slice(offset, offset + limit).map(serializeManagerApplication);

    res.json({
      applications: page,
      total: applications.length,
      limit,
      offset,
      warning: scoped.warning,
    });
  } catch (error) {
    log.error('[Manager Router] Failed to list applications:', error);
    res.status(500).json({ error: 'Unable to load manager applications.' });
  }
});

managerRouter.get('/queue', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  try {
    const scoped = await scopedApplywizzIds(req);
    const filter = (rows: ApplicationRow[]) =>
      rows.filter((row) => inScope(row, scoped.ids)).map(serializeManagerApplication);
    const [queued, applying, otpRequired] = await Promise.all([
      listApplications({ status: 'QUEUED' }),
      listApplications({ status: 'APPLYING' }),
      listApplications({ status: 'OTP_REQUIRED' }),
    ]);
    res.json({
      queued: filter(queued),
      applying: filter(applying),
      otpRequired: filter(otpRequired),
      warning: scoped.warning,
    });
  } catch (error) {
    log.error('[Manager Router] Failed to load queue:', error);
    res.status(500).json({ error: 'Unable to load manager queue.' });
  }
});

managerRouter.get('/candidates', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  try {
    const scoped = await scopedApplywizzIds(req);
    if (scoped.ids && scoped.ids.length === 0) {
      res.json({ candidates: [], warning: scoped.warning || 'No clients linked to this manager.' });
      return;
    }
    if (isSupabaseConfigured()) {
      let query = getDbClient()
        .from('profiles')
        .select('applywizz_id, client_name, company_email, country, location, zoho_connected, updated_at')
        .order('client_name', { ascending: true });
      if (scoped.ids) query = query.in('applywizz_id', scoped.ids);
      const { data, error } = await query;
      if (error) throw error;
      res.json({ candidates: data ?? [], warning: scoped.warning });
      return;
    }

    const applications = (
      scoped.ids && scoped.ids.length === 1
        ? await listApplications({ applywizzId: scoped.ids[0] })
        : await listApplications()
    ).filter((application) => inScope(application, scoped.ids));
    const candidates = Array.from(
      new Map(
        applications.map((application) => [
          application.applywizz_id,
          { applywizz_id: application.applywizz_id, application_count: 1 },
        ])
      ).entries()
    ).map(([, candidate]) => candidate);
    res.json({ candidates, warning: scoped.warning });
  } catch (error) {
    log.error('[Manager Router] Failed to load candidates:', error);
    res.status(500).json({ error: 'Unable to load manager candidates.' });
  }
});

managerRouter.patch('/applications/:id/assignment', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  const assignedCaEmail = req.body?.assignedCaEmail;
  if (assignedCaEmail !== null && typeof assignedCaEmail !== 'string') {
    res.status(400).json({ error: 'assignedCaEmail must be a string or null.' });
    return;
  }
  if (typeof assignedCaEmail === 'string' && assignedCaEmail.trim() && !assignedCaEmail.includes('@')) {
    res.status(400).json({ error: 'assignedCaEmail must be a valid email address.' });
    return;
  }

  try {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'Application assignment requires Supabase.' });
      return;
    }
    const scoped = await scopedApplywizzIds(req);
    const applicationId = String(req.params.id);
    const { data: existing, error: existingError } = await getDbClient()
      .from('gh_candidate_applications')
      .select('*')
      .eq('id', applicationId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      res.status(404).json({ error: `Application '${applicationId}' not found.` });
      return;
    }
    if (scoped.ids && !inScope(existing as ApplicationRow, scoped.ids)) {
      res.status(403).json({ error: 'Application is not on this manager team.' });
      return;
    }

    const nextEmail = typeof assignedCaEmail === 'string' ? assignedCaEmail.trim() || null : null;
    const { data, error } = await getDbClient()
      .from('gh_candidate_applications')
      .update({ assigned_ca_email: nextEmail })
      .eq('id', applicationId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    void insertAuditEvent({
      actorEmail: getAuthenticatedEmail(req),
      actorRole: resolveRole((req as AuthenticatedRequest).user),
      action: 'assignment_patch',
      targetType: 'application',
      targetId: applicationId,
      metadata: { assigned_ca_email: nextEmail, previous: existing.assigned_ca_email || null },
    });
    res.json({ application: serializeManagerApplication(data as ApplicationRow) });
  } catch (error) {
    log.error('[Manager Router] Failed to update assignment:', error);
    res.status(500).json({ error: 'Unable to update application assignment.' });
  }
});

export default managerRouter;
