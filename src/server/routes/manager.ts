/**
 * Manager dashboard API.
 *
 * These endpoints are intentionally scoped to administrators.  Campus
 * ambassador filtering belongs to the candidate/operator routes; managers
 * need an unfiltered view of the application pipeline.
 */

import { Router, type Request, type Response } from 'express';
import {
  countApplicationsByStatus,
  getISTDateRangeUtc,
  listApplications,
  type ApplicationRow,
  type ApplicationStatus,
} from '../../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { config } from '../../config/env.js';
import { getISTDateString } from '../../services/workHistoryClient.js';
import { isUserAdmin } from './auth.js';

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

function requireManager(req: Request, res: Response): boolean {
  if (!isUserAdmin((req as Request & { user?: unknown }).user)) {
    res.status(403).json({ error: 'Manager access is required.' });
    return false;
  }
  return true;
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

interface ManagerApplicationRow extends ApplicationRow {
  profiles?: {
    applywizz_id?: string | null;
    client_name?: string | null;
  } | null;
}

interface ManagerClientRow {
  client: string;
  applications: number;
  completed: number;
  pending: number;
  failed: number;
  waitingForEmail: number;
  assignedTo: string;
  completedApplications: Array<Record<string, string>>;
  pendingApplications: Array<Record<string, string>>;
  failedApplications: Array<Record<string, string>>;
  expanded_details: {
    completed: Array<Record<string, string>>;
    failed: Array<Record<string, string>>;
    pending: Array<Record<string, string>>;
  };
}

function getAuthenticatedEmail(req: Request): string {
  const user = (req as Request & { user?: { email?: string; user_metadata?: { email?: string } } }).user;
  return String(user?.email || user?.user_metadata?.email || '').trim().toLowerCase();
}

/**
 * Resolves the CAs linked to the manager.  The response parser accepts both
 * the current array response and the object wrappers used by older API
 * deployments.
 */
async function fetchLinkedCaIds(managerEmail: string): Promise<string[]> {
  const configuredUrl = new URL(config.APPLYWIZZ_API_URL);
  configuredUrl.search = '';
  configuredUrl.searchParams.set('careerassociatemanager_id', managerEmail);

  const response = await fetch(configuredUrl, {
    headers: { Accept: 'application/json', 'User-Agent': 'ApplyWizz-Greenhouse-Automation/1.0' },
  });
  if (!response.ok) {
    throw new Error(`ApplyWizz API returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(root.candidates)
      ? root.candidates
      : Array.isArray(root.clients)
        ? root.clients
        : Array.isArray(root.data)
          ? root.data
          : [];

  const ids = candidates.flatMap((candidate) => {
    if (typeof candidate === 'string') return [candidate];
    if (!candidate || typeof candidate !== 'object') return [];
    const row = candidate as Record<string, unknown>;
    const id = row.applywizz_id ?? row.applywizzId ?? row.client_id ?? row.clientId;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  });
  return Array.from(new Set(ids));
}

function clientName(row: ManagerApplicationRow): string {
  return row.profiles?.client_name?.trim() || row.applywizz_id;
}

function assignedCaName(row: ManagerApplicationRow): string {
  return (row.assigned_ca_email || '').trim();
}

function detailFor(row: ManagerApplicationRow, includeProofs: boolean): Record<string, string> {
  const detail: Record<string, string> = { job_url: row.job_url };
  if (includeProofs) {
    detail.proof_web_url = row.proof_web_url || '';
    detail.proof_email_url = row.proof_email_url || '';
  } else if (row.status === 'FAILED' && row.error_message) {
    detail.error_message = row.error_message;
  }
  if (row.status === 'FAILED') detail.error_message = row.error_message || '';
  return detail;
}

function isWaitingForEmail(row: ManagerApplicationRow): boolean {
  return row.status === 'EMAIL_PROOF_PENDING' || row.status === 'OTP_REQUIRED';
}

/**
 * GET /api/manager/dashboard?date=YYYY-MM-DD&ca=<name|all>
 * Returns client-level application metrics for the authenticated manager.
 */
managerRouter.get('/dashboard', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  const managerEmail = getAuthenticatedEmail(req);
  if (!managerEmail) {
    res.status(401).json({ error: 'Authenticated manager email is required.' });
    return;
  }

  const requestedDate = typeof req.query.date === 'string' ? req.query.date : undefined;
  if (requestedDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
    return;
  }
  const date = requestedDate || getISTDateString();
  const requestedCa = typeof req.query.ca === 'string' ? req.query.ca.trim() : 'all';
  if (!requestedCa || requestedCa.toLowerCase() === 'all') {
    // "all" is the default and is handled below without a client filter.
  }

  try {
    const caIds = await fetchLinkedCaIds(managerEmail);
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'Manager dashboard requires Supabase.' });
      return;
    }

    const { startIso, endIso } = getISTDateRangeUtc(date);
    let query = getDbClient()
      .from('candidate_applications')
      .select('*, profiles!inner(applywizz_id, client_name)')
      .in('applywizz_id', caIds.length ? caIds : ['__no_linked_ca__'])
      .gte('created_at', startIso)
      .lte('created_at', endIso);
    const { data, error } = await query;
    if (error) throw error;

    const applications = (data || []) as ManagerApplicationRow[];
    const filtered = requestedCa.toLowerCase() === 'all'
      ? applications
      : applications.filter(
          (row) => assignedCaName(row).toLowerCase() === requestedCa.toLowerCase()
        );
    const grouped = new Map<string, ManagerClientRow>();

    for (const application of filtered) {
      const name = clientName(application);
      const row = grouped.get(name) || {
        client: name,
        applications: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        waitingForEmail: 0,
        assignedTo: assignedCaName(application) || '—',
        completedApplications: [],
        pendingApplications: [],
        failedApplications: [],
        expanded_details: { completed: [], failed: [], pending: [] },
      };
      row.applications += 1;
      row.assignedTo = assignedCaName(application) || row.assignedTo;
      if (application.status === 'APPLIED') {
        row.completed += 1;
        const detail = detailFor(application, true);
        row.completedApplications.push(detail);
        row.expanded_details.completed.push(detail);
      } else if (application.status === 'FAILED' || application.status === 'CAPTCHA_TIMEOUT') {
        row.failed += 1;
        const detail = detailFor(application, false);
        row.failedApplications.push(detail);
        row.expanded_details.failed.push(detail);
      } else {
        row.pending += 1;
        const detail = { job_url: application.job_url };
        row.pendingApplications.push(detail);
        row.expanded_details.pending.push(detail);
      }
      if (isWaitingForEmail(application)) row.waitingForEmail += 1;
      grouped.set(name, row);
    }

    const rows = Array.from(grouped.values());
    const totals = rows.reduce(
      (total, row) => ({
        applications: total.applications + row.applications,
        applied: total.applied + row.completed,
        failed: total.failed + row.failed,
        pending: total.pending + row.pending,
        waiting_for_email: total.waiting_for_email + row.waitingForEmail,
      }),
      { applications: 0, applied: 0, failed: 0, pending: 0, waiting_for_email: 0 }
    );

    res.json({
      date,
      ca: requestedCa.toLowerCase() === 'all' ? 'all' : requestedCa,
      rows,
      clients: rows.map((row) => row.client),
      totals,
    });
  } catch (error) {
    console.error('[Manager Router] Failed to load dashboard:', error);
    res.status(502).json({ error: 'Unable to load manager dashboard.' });
  }
});

/**
 * GET /api/manager/overview
 * Returns aggregate pipeline metrics for the manager dashboard.
 */
managerRouter.get(['/overview', '/stats'], async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  try {
    const applications = await listApplications();
    const statuses = await Promise.all(
      APPLICATION_STATUSES.map(async (status) => [status, await countApplicationsByStatus(status)] as const)
    );
    const statusCounts = Object.fromEntries(statuses);
    const candidateIds = new Set(applications.map((application) => application.applywizz_id));

    res.json({
      candidates: candidateIds.size,
      applications: applications.length,
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
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Manager Router] Failed to load overview:', error);
    res.status(500).json({ error: 'Unable to load manager overview.' });
  }
});

/**
 * GET /api/manager/applications
 * Lists applications with optional status/candidate filters and pagination.
 */
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
    const applications = await listApplications({
      status: status as ApplicationStatus | undefined,
      applywizzId,
    });
    const page = applications.slice(offset, offset + limit).map(serializeManagerApplication);

    res.json({
      applications: page,
      total: applications.length,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[Manager Router] Failed to list applications:', error);
    res.status(500).json({ error: 'Unable to load manager applications.' });
  }
});

/**
 * GET /api/manager/queue
 * Returns the submission queue in its existing database ordering.
 */
managerRouter.get('/queue', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  try {
    const [queued, applying, otpRequired] = await Promise.all([
      listApplications({ status: 'QUEUED' }),
      listApplications({ status: 'APPLYING' }),
      listApplications({ status: 'OTP_REQUIRED' }),
    ]);
    res.json({
      queued: queued.map(serializeManagerApplication),
      applying: applying.map(serializeManagerApplication),
      otpRequired: otpRequired.map(serializeManagerApplication),
    });
  } catch (error) {
    console.error('[Manager Router] Failed to load queue:', error);
    res.status(500).json({ error: 'Unable to load manager queue.' });
  }
});

/**
 * GET /api/manager/candidates
 * Lists candidate directory rows.  Profiles remain the source of identity data.
 */
managerRouter.get('/candidates', async (req: Request, res: Response): Promise<void> => {
  if (!requireManager(req, res)) return;

  try {
    if (isSupabaseConfigured()) {
      const { data, error } = await getDbClient()
        .from('profiles')
        .select('applywizz_id, client_name, company_email, country, location, zoho_connected, updated_at')
        .order('client_name', { ascending: true });
      if (error) throw error;
      res.json({ candidates: data ?? [] });
      return;
    }

    const applications = await listApplications();
    const candidates = Array.from(
      new Map(
        applications.map((application) => [
          application.applywizz_id,
          { applywizz_id: application.applywizz_id, application_count: 1 },
        ])
      ).entries()
    ).map(([, candidate]) => candidate);
    res.json({ candidates });
  } catch (error) {
    console.error('[Manager Router] Failed to load candidates:', error);
    res.status(500).json({ error: 'Unable to load manager candidates.' });
  }
});

/**
 * PATCH /api/manager/applications/:id/assignment
 * Assigns an application to a CA without changing its lifecycle status.
 */
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
    const { data, error } = await getDbClient()
      .from('candidate_applications')
      .update({ assigned_ca_email: typeof assignedCaEmail === 'string' ? assignedCaEmail.trim() || null : null })
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: `Application '${req.params.id}' not found.` });
      return;
    }
    res.json({ application: serializeManagerApplication(data as ApplicationRow) });
  } catch (error) {
    console.error('[Manager Router] Failed to update assignment:', error);
    res.status(500).json({ error: 'Unable to update application assignment.' });
  }
});

export default managerRouter;
