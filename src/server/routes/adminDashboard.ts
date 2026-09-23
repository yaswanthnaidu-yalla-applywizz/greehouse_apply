/**
 * Admin org-ops API. Strictly admin + dev (via requireRole on /api/admin).
 */

import { Router, type Request, type Response } from 'express';
import {
  countApplicationsByStatus,
  countOperatorWorkloadByProfileCaEmail,
  
  
  getDashboardApplicationMetrics,
  getISTDateRangeUtc,
  type ApplicationStatus,
} from '../../db/applications.js';
import { queryRollupStats } from '../../db/statsRollup.js';
import crypto from 'crypto';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { insertAuditEvent, listAuditEvents } from '../../db/events.js';
import { upsertIngestRun } from '../../db/ingestRuns.js';
import { getISTDateString } from '../../services/workHistoryClient.js';
import { parseDashboardStatsRange, serializeDateRange } from '../dashboardDateRange.js';
import { emailsForRole, isUserAdmin, resolveRole } from './auth.js';
import { buildManagerTeamStats } from '../adminManagerStats.js';
import { loadClientDashboard } from '../clientDashboard.js';
import { listAllDashboardUsers, listOperatorEmailsForManager } from '../../db/users.js';
import { isActiveWithin, listAuthDirectory } from '../authDirectory.js';
import { collectHealthSnapshot, trafficLights } from '../healthSnapshot.js';
import { getAuthenticatedCaEmail } from '../workHistoryAuth.js';
import { getIngestRun, setIngestRun } from '../runtimeState.js';
import {
  isPipelineStopEnabled,
  requestPipelineAbort,
  resetPipelineAbort,
} from '../../orchestrator/pipelineAbort.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
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
  'SKIPPED',
];

function parseLimit(value: unknown, fallback = 100): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 500);
}

adminDashboardRouter.get('/overview', async (_req: Request, res: Response): Promise<void> => {
  try {
    const parsedRange = parseDashboardStatsRange(_req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const createdAtRange = { startIso: parsedRange.startIso, endIso: parsedRange.endIso };
    

    const directory = await listAuthDirectory();
    const operators = directory.filter((user) => user.role === 'operator');
    const activeOperators = operators.filter((user) => isActiveWithin(user.lastSignInAt));

    const [rollup, queued, applying, metrics, audit] = await Promise.all([
      queryRollupStats(parsedRange.startIso, parsedRange.endIso!),
      countApplicationsByStatus('QUEUED', createdAtRange),
      countApplicationsByStatus('APPLYING', createdAtRange),
      getDashboardApplicationMetrics({ createdAtRange }),
      listAuditEvents({ limit: 15 }),
    ]);

    const totalFields = metrics.totalFieldsPopulated ?? 0;

    res.json({
      operators: operators.length,
      activeOperators: activeOperators.length,
      inactiveOperators: Math.max(0, operators.length - activeOperators.length),
      submitted: rollup.submitted_count,
      applied: rollup.applied_count,
      running: applying,
      queued,
      failed: rollup.failed_count,
      supabasePercent: totalFields > 0
        ? Math.round((metrics.supabaseTaggedCount / totalFields) * 100)
        : 0,
      aiPercent: totalFields > 0
        ? Math.round((metrics.aiTaggedCount / totalFields) * 100)
        : 0,
      resumePercent: totalFields > 0
        ? Math.round((metrics.resumeTaggedCount / totalFields) * 100)
        : 0,
      recentActivity: audit.events,
      warning: audit.warning,
      dateRange: serializeDateRange(parsedRange),
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
    const hasStatsRange = typeof req.query.range === 'string' || typeof req.query.from === 'string' || typeof req.query.to === 'string';
    const parsedRange = !hasStatsRange && requestedDate
      ? { ...getISTDateRangeUtc(requestedDate), preset: 'custom' as const, fromDate: requestedDate, toDate: requestedDate, label: requestedDate }
      : parseDashboardStatsRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const payload = await loadClientDashboard({
      managerEmail: email,
      date: requestedDate,
      createdAtRange: { startIso: parsedRange.startIso, endIso: parsedRange.endIso },
      dateRangeMeta: serializeDateRange(parsedRange),
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
      .from('gh_candidate_applications')
      .select('id, applywizz_id, job_url, company_name, job_title, status, assigned_ca_email, created_at, updated_at, submitted_at, error_message, proof_web_url, proof_email_url, proof_email_json, proof_captured_at, profiles(client_name, ca_email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) query = query.eq('status', status);
    if (date) {
      const { startIso, endIso } = getISTDateRangeUtc(date);
      query = query.gte('created_at', startIso).lte('created_at', endIso);
    }
    const { data, error, count } = await query;
    if (error) throw error;

    let rows = (data || []).map((row: any) => {
      const candidateName = row.profiles?.client_name || row.applywizz_id || '';
      const caEmail = row.assigned_ca_email || row.profiles?.ca_email || '';
      return {
        id: row.id,
        applywizzId: row.applywizz_id,
        client: candidateName,
        client_name: candidateName,
        candidate_name: candidateName,
        candidateName,
        jobUrl: row.job_url,
        companyName: row.company_name,
        jobTitle: row.job_title,
        status: row.status,
        operator: caEmail,
        assigned_ca_email: caEmail,
        assignedCaEmail: caEmail,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        submittedAt: row.submitted_at,
        errorMessage: row.error_message || '',
        error_message: row.error_message || '',
        proof_web_url: row.proof_web_url || null,
        proof_email_url: row.proof_email_url || null,
        proof_email_json: row.proof_email_json || null,
        proof_captured_at: row.proof_captured_at || null,
      };
    });
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

adminDashboardRouter.post(
  '/trigger-ingest-from-storage',
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const ingestServiceUrl = (process.env.INGEST_SERVICE_URL || '').trim().replace(/\/+$/, '');

    if (ingestServiceUrl) {
      log.info(`[Admin] Forwarding ingest trigger to ingest service at ${ingestServiceUrl}`);
      try {
        const headers: Record<string, string> = {};
        if (req.headers.authorization) {
          headers.authorization = req.headers.authorization;
        }
        if (req.headers['content-type']) {
          headers['content-type'] = req.headers['content-type'] as string;
        }
        const actorEmail = getAuthenticatedCaEmail(authReq) || (authReq.user as { email?: string } | undefined)?.email || '';
        if (actorEmail) {
          headers['x-user-email'] = actorEmail;
        }

        const response = await fetch(`${ingestServiceUrl}/api/admin/trigger-ingest-from-storage`, {
          method: 'POST',
          headers,
          body: req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : undefined,
        });

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await response.json();
          res.status(response.status).json(data);
        } else {
          const text = await response.text();
          res.status(response.status).send(text);
        }
      } catch (err: any) {
        log.error(`[Admin] Failed forwarding ingest trigger to ${ingestServiceUrl}:`, err);
        res.status(502).json({
          error: `Failed to communicate with ingest service at ${ingestServiceUrl}`,
          details: err?.message || String(err),
        });
      }
      return;
    }

    if (!isUserAdmin(authReq.user || getAuthenticatedCaEmail(authReq))) {
      res.status(403).json({ error: 'Forbidden: only admins can start the pipeline.' });
      return;
    }

    if (getIngestRun().running) {
      res.status(409).json({
        error: 'Ingestion is already running.',
        ...getIngestRun(),
      });
      return;
    }

    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    resetPipelineAbort();
    setIngestRun({ running: true, runId, status: 'running', startedAt });
    const actorEmail = getAuthenticatedCaEmail(authReq) || (authReq.user as { email?: string } | undefined)?.email || '';
    void insertAuditEvent({
      actorEmail,
      actorRole: resolveRole(authReq.user || actorEmail),
      action: 'ingest_start',
      targetType: 'pipeline',
      targetId: startedAt,
    });
    void upsertIngestRun({
      id: runId,
      status: 'running',
      started_at: startedAt,
      phase: 'Starting',
      message: 'Storage CSV ingestion started',
      triggered_by: actorEmail,
    });
    log.info(`[Admin] ▶️ Storage CSV ingestion started at ${startedAt}`);
    res.status(202).json({ started: true, startedAt, runId });

    try {
      const { ingestCsvFromStorage } = await import('../../scanner/storageCsvIngestion.js');
      const result = await ingestCsvFromStorage({ runId, triggeredBy: actorEmail });
      setIngestRun({
        running: false,
        runId,
        status: result.success ? 'completed' : result.aborted ? 'aborted' : 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        processedCount: result.processedCount,
        processedFile: result.processedFile,
        message: result.success ? result.message : result.aborted ? 'Pipeline stopped by operator.' : undefined,
        error: result.success ? undefined : result.message,
      });
      void upsertIngestRun({
        id: runId,
        status: result.success ? 'completed' : result.aborted ? 'aborted' : 'failed',
        finished_at: new Date().toISOString(),
        processed_count: result.processedCount,
        processed_file: result.processedFile,
        phase: result.success ? 'Completed' : result.aborted ? 'Aborted' : 'Failed',
        message: result.success ? result.message : result.aborted ? 'Pipeline stopped by operator.' : undefined,
        error: result.success ? undefined : result.message,
        triggered_by: actorEmail,
      });
      log.info(
        `[Admin] ${result.success ? '✅' : result.aborted ? '⏹️' : '❌'} Storage CSV ingestion finished: ${result.message}`
      );
    } catch (err: any) {
      const message = err?.message || 'Storage ingestion failed';
      setIngestRun({
        running: false,
        runId,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
      });
      void upsertIngestRun({
        id: runId,
        status: 'failed',
        finished_at: new Date().toISOString(),
        phase: 'Failed',
        error: message,
        message,
        triggered_by: actorEmail,
      });
      log.error('[Admin] ❌ Storage CSV ingestion failed:', err);
    } finally {
      resetPipelineAbort();
    }
  }
);

adminDashboardRouter.post(
  '/stop-ingest',
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const ingestServiceUrl = (process.env.INGEST_SERVICE_URL || '').trim().replace(/\/+$/, '');

    if (ingestServiceUrl) {
      log.info(`[Admin] Forwarding stop ingest to ingest service at ${ingestServiceUrl}`);
      try {
        const headers: Record<string, string> = {};
        if (req.headers.authorization) {
          headers.authorization = req.headers.authorization;
        }
        const actorEmail = getAuthenticatedCaEmail(authReq) || (authReq.user as { email?: string } | undefined)?.email || '';
        if (actorEmail) {
          headers['x-user-email'] = actorEmail;
        }

        const response = await fetch(`${ingestServiceUrl}/api/admin/stop-ingest`, {
          method: 'POST',
          headers,
        });

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await response.json();
          res.status(response.status).json(data);
        } else {
          const text = await response.text();
          res.status(response.status).send(text);
        }
      } catch (err: any) {
        log.error(`[Admin] Failed forwarding stop ingest to ${ingestServiceUrl}:`, err);
        res.status(502).json({
          error: `Failed to communicate with ingest service at ${ingestServiceUrl}`,
          details: err?.message || String(err),
        });
      }
      return;
    }

    if (!isUserAdmin(authReq.user || getAuthenticatedCaEmail(authReq))) {
      res.status(403).json({ error: 'Forbidden: only admins can stop the pipeline.' });
      return;
    }
    if (!isPipelineStopEnabled()) {
      res.status(403).json({
        error: 'Pipeline stop is disabled. Set NODE_ENV=development or ENABLE_PIPELINE_STOP=true.',
      });
      return;
    }
    if (!getIngestRun().running) {
      res.status(409).json({ error: 'No ingestion run is in progress.', ...getIngestRun() });
      return;
    }
    requestPipelineAbort();
    log.warn('[Admin] ⏹️ Storage CSV ingestion stop requested by operator');

    const stoppedAt = new Date().toISOString();
    const currentRun = getIngestRun();
    const runId = currentRun.runId;

    // Update in-memory state
    setIngestRun({
      ...currentRun,
      running: false,
      status: 'stopped',
      finishedAt: stoppedAt,
      message: 'Pipeline stopped by operator.',
    });

    // Update Supabase ingest_runs row
    if (isSupabaseConfigured()) {
      try {
        const client = getDbClient();
        if (runId) {
          await client
            .from('ingest_runs')
            .update({
              status: 'stopped',
              finished_at: stoppedAt,
              message: 'Pipeline stopped by operator.',
              updated_at: stoppedAt,
            })
            .eq('id', runId);
        } else {
          // Fallback: update most recent running ingest_run
          const { data: latest } = await client
            .from('ingest_runs')
            .select('id')
            .eq('status', 'running')
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (latest?.id) {
            await client
              .from('ingest_runs')
              .update({
                status: 'stopped',
                finished_at: stoppedAt,
                message: 'Pipeline stopped by operator.',
                updated_at: stoppedAt,
              })
              .eq('id', latest.id);
          }
        }
      } catch (err: any) {
        log.warn(`[Admin] Failed updating ingest_runs row to stopped: ${err.message}`);
      }
    }

    res.json({ stopping: true, ...getIngestRun() });
  }
);

adminDashboardRouter.get(
  '/ingest-status',
  async (req: Request, res: Response): Promise<void> => {
    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await getDbClient()
          .from('ingest_runs')
          .select('*')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!error && data) {
          res.json({
            id: data.id,
            running: data.status === 'running',
            status: data.status,
            phase: data.phase,
            startedAt: data.started_at,
            finishedAt: data.finished_at,
            processedCount: data.processed_count ?? 0,
            processedFile: data.processed_file,
            message: data.message,
            error: data.error,
            triggeredBy: data.triggered_by,
            stopEnabled: isPipelineStopEnabled(),
          });
          return;
        }
      } catch (err: any) {
        log.warn(`[Admin] Could not query latest ingest_run from DB: ${err.message}`);
      }
    }

    const authReq = req as AuthenticatedRequest;
    const ingestServiceUrl = (process.env.INGEST_SERVICE_URL || '').trim().replace(/\/+$/, '');

    if (ingestServiceUrl) {
      log.info(`[Admin] Forwarding ingest status to ingest service at ${ingestServiceUrl}`);
      try {
        const headers: Record<string, string> = {};
        if (req.headers.authorization) {
          headers.authorization = req.headers.authorization;
        }
        const actorEmail = getAuthenticatedCaEmail(authReq) || (authReq.user as { email?: string } | undefined)?.email || '';
        if (actorEmail) {
          headers['x-user-email'] = actorEmail;
        }

        const response = await fetch(`${ingestServiceUrl}/api/admin/ingest-status`, {
          method: 'GET',
          headers,
        });

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await response.json();
          res.status(response.status).json(data);
        } else {
          const text = await response.text();
          res.status(response.status).send(text);
        }
      } catch (err: any) {
        log.error(`[Admin] Failed forwarding ingest status to ${ingestServiceUrl}:`, err);
        res.status(502).json({
          error: `Failed to communicate with ingest service at ${ingestServiceUrl}`,
          details: err?.message || String(err),
        });
      }
      return;
    }

    res.json({ ...getIngestRun(), stopEnabled: isPipelineStopEnabled() });
  }
);
