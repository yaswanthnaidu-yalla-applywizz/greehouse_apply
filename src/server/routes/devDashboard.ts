/**
 * Developer monitoring API. Restricted to role=dev.
 */

import { Router, type Request, type Response } from 'express';
import {
  getApplication,
  getISTDateRangeUtc,
  hydrateApplicationProofUrls,
  listApplications,
} from '../../db/applications.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { listApplicationEvents } from '../../db/events.js';
import { getISTDateString } from '../../services/workHistoryClient.js';
import { collectHealthSnapshot } from '../healthSnapshot.js';
import { displayNameMapForEmails } from '../authDirectory.js';
import { emailsForRole } from './auth.js';
import { fetchLinkedCaIds } from '../clientDashboard.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('Dev Dashboard');

export const devDashboardRouter = Router();

function parseLimit(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

devDashboardRouter.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await collectHealthSnapshot());
  } catch (error) {
    log.error('[Dev] health failed:', error);
    res.status(500).json({ error: 'Unable to load health snapshot.' });
  }
});

devDashboardRouter.get('/runs', async (req: Request, res: Response): Promise<void> => {
  const date = typeof req.query.date === 'string' ? req.query.date.trim() : getISTDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
    return;
  }
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const limit = parseLimit(req.query.limit, 100);
  const offset = Math.max(0, Number.parseInt(String(req.query.offset || '0'), 10) || 0);

  try {
    if (!isSupabaseConfigured()) {
      res.status(503).json({ error: 'Runs list requires Supabase.' });
      return;
    }
    const { startIso, endIso } = getISTDateRangeUtc(date);
    let query = getDbClient()
      .from('candidate_applications')
      .select('id, applywizz_id, job_url, company_name, job_title, status, assigned_ca_email, created_at, updated_at, submitted_at, error_message, profiles!inner(client_name)', { count: 'exact' })
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query;
    if (error) throw error;

    const runs = (data || []).map((row: any) => {
      const started = Date.parse(row.created_at || '');
      const ended = Date.parse(row.submitted_at || row.updated_at || '');
      const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
      return {
        id: row.id,
        applywizzId: row.applywizz_id,
        client: row.profiles?.client_name || row.applywizz_id,
        jobUrl: row.job_url,
        companyName: row.company_name,
        jobTitle: row.job_title,
        status: row.status,
        operator: row.assigned_ca_email || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        submittedAt: row.submitted_at,
        durationMs,
        errorMessage: row.error_message || '',
      };
    });

    res.json({ date, runs, total: count ?? runs.length, limit, offset });
  } catch (error) {
    log.error('[Dev] runs failed:', error);
    res.status(500).json({ error: 'Unable to load application runs.' });
  }
});

devDashboardRouter.get('/errors', async (req: Request, res: Response): Promise<void> => {
  const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
    return;
  }
  try {
    let failed = await listApplications({ status: 'FAILED' });
    const captchaTimeout = await listApplications({ status: 'CAPTCHA_TIMEOUT' });
    failed = [...failed, ...captchaTimeout];
    if (date) {
      const { startIso, endIso } = getISTDateRangeUtc(date);
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      failed = failed.filter((row) => {
        const at = Date.parse(row.updated_at || row.created_at || '');
        return Number.isFinite(at) && at >= start && at <= end;
      });
    }

    const groups = new Map<
      string,
      { errorType: string; message: string; count: number; first: string; last: string; applicationIds: string[] }
    >();
    for (const row of failed) {
      const message = (row.error_message || 'Unknown error').trim();
      const errorType = row.status;
      const key = `${errorType}::${message}`;
      const at = row.updated_at || row.created_at || new Date().toISOString();
      const current = groups.get(key) || {
        errorType,
        message,
        count: 0,
        first: at,
        last: at,
        applicationIds: [],
      };
      current.count += 1;
      if (at < current.first) current.first = at;
      if (at > current.last) current.last = at;
      if (row.id && current.applicationIds.length < 20) current.applicationIds.push(row.id);
      groups.set(key, current);
    }

    res.json({
      errors: Array.from(groups.values()).sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    log.error('[Dev] errors failed:', error);
    res.status(500).json({ error: 'Unable to load errors.' });
  }
});

devDashboardRouter.get('/queue', async (_req: Request, res: Response): Promise<void> => {
  try {
    const snapshot = await collectHealthSnapshot();
    const [queued, applying] = await Promise.all([
      listApplications({ status: 'QUEUED' }),
      listApplications({ status: 'APPLYING' }),
    ]);
    res.json({
      generatedAt: snapshot.generatedAt,
      workers: snapshot.workers,
      queue: snapshot.queue,
      pending: queued.slice(0, 50).map((row) => ({
        id: row.id,
        applywizzId: row.applywizz_id,
        jobUrl: row.job_url,
        status: row.status,
        assignedCaEmail: row.assigned_ca_email,
        updatedAt: row.updated_at,
      })),
      running: applying.slice(0, 50).map((row) => ({
        id: row.id,
        applywizzId: row.applywizz_id,
        jobUrl: row.job_url,
        status: row.status,
        assignedCaEmail: row.assigned_ca_email,
        updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    log.error('[Dev] queue failed:', error);
    res.status(500).json({ error: 'Unable to load queue snapshot.' });
  }
});

devDashboardRouter.get('/integrations', async (_req: Request, res: Response): Promise<void> => {
  try {
    const snapshot = await collectHealthSnapshot();
    res.json({
      generatedAt: snapshot.generatedAt,
      integrations: snapshot.probes.filter((probe) =>
        ['database', 'storage', 'email_otp', 'zoho', 'applywizz'].includes(probe.name)
      ),
    });
  } catch (error) {
    log.error('[Dev] integrations failed:', error);
    res.status(500).json({ error: 'Unable to load integrations.' });
  }
});

devDashboardRouter.get('/applications/:id', async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ error: 'Application ID is required.' });
    return;
  }
  try {
    let app = await getApplication(id);
    if (!app) {
      res.status(404).json({ error: `Application '${id}' not found.` });
      return;
    }
    app = await hydrateApplicationProofUrls(app);
    const events = app.id ? await listApplicationEvents({ applicationId: app.id, limit: 200 }) : { events: [] };
    const names = await displayNameMapForEmails([app.assigned_ca_email || '']);
    let managerEmail: string | null = null;
    for (const email of emailsForRole('manager')) {
      const linked = await fetchLinkedCaIds(email);
      if (linked.ids.some((candidateId) => candidateId.toUpperCase() === app!.applywizz_id.toUpperCase())) {
        managerEmail = email;
        break;
      }
    }

    res.json({
      application: {
        ...app,
        operatorName: names.get((app.assigned_ca_email || '').trim().toLowerCase()) || app.assigned_ca_email || '',
        managerEmail,
      },
      events: events.events,
      warning: events.warning,
    });
  } catch (error) {
    log.error('[Dev] debugger failed:', error);
    res.status(500).json({ error: 'Unable to load application debugger.' });
  }
});
