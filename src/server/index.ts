import { devDbRouter } from './routes/devDb.js';
import {
  candidatesRouter,
  artifactCache,
  rebuildLookupMaps,
  type CandidateSummary,
  type ArtifactCache,
} from './routes/candidates.js';

export { artifactCache, type CandidateSummary, type ArtifactCache };
/**
 * @fileoverview Presentation REST API Server for Greenhouse Operator Dashboard (Phase V1-5).
 *
 * Express.js backend serving candidate queues, job details, and pre-populated form templates
 * with strict source attribution tags ('supabase' vs 'ai').
 *
 * References:
 * - 02-trd.md (Section 3.5)
 * - 04-ui-ux.md (Section 2)
 * - 05-backend-schema.md (Section 1.4)
 * - 06-implementation.md (Phase V1-5)
 */

import WebSocket from 'ws';

// Polyfill global WebSocket for Supabase Realtime in Node.js environments
if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as any).WebSocket = WebSocket;
}

import { setupProcessCrashGuard, sweepStaleApplications } from './crashGuard.js';
import { browserManager } from '../submitter/browserManager.js';
// Install top-level process crash guards immediately before any server bootstrap code
setupProcessCrashGuard();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { upsertIngestRun } from '../db/ingestRuns.js';
import { config } from '../config/env.js';
import { applicationsRouter } from './routes/applications.js';
import { submissionsRouter } from './routes/submissions.js';
import { startFailureDiagnosticsRetention } from '../services/failureDiagnosticsRetention.js';
import { authRouter, isUserAdmin, resolveRole } from './routes/auth.js';
import { notificationsRouter } from './routes/notifications.js';
import { configRouter } from './routes/config.js';
import { managerRouter } from './routes/manager.js';
import { adminDashboardRouter } from './routes/adminDashboard.js';
import { devDashboardRouter } from './routes/devDashboard.js';
import { wsManager } from './ws.js';
import { requireAuth, type AuthenticatedRequest } from './middleware/auth.js';
import {
  requireOperatorDashboardAccess,
  requireRole,
  requireRoleIfAuthenticated,
} from './routes/requireRole.js';
import { getIngestRun, getQueueDaemon, registerQueueDaemon, setIngestRun } from './runtimeState.js';
import {
  isPipelineStopEnabled,
  requestPipelineAbort,
  resetPipelineAbort,
} from '../orchestrator/pipelineAbort.js';
import { insertAuditEvent } from '../db/events.js';
import { getAuthenticatedCaEmail } from './workHistoryAuth.js';
import { getDashboardApplicationMetrics } from '../db/applications.js';
import { getApplicationStats } from '../db/applicationStats.js';
import {
  istDatesForWorkHistory,
  parseDashboardStatsRange,
  serializeDateRange,
} from './dashboardDateRange.js';
import { mergeWorkHistoryForIstDates } from './workHistorySpan.js';
import {
  hasUnrestrictedDashboardAccess,
  resolveRequestAppRole,
  resolveTeamCandidateIdsForManager,
  resolveViewAsOperatorManagerEmail,
} from './managerTeamScope.js';
import { usersRouter } from './routes/users.js';
import {
  isSupabaseConfigured,
  logSupabaseCredentialIdentity,
  resolveSupabaseCredentials,
  listSupabaseKeyCandidates,
  createSupabaseServerClient,
} from '../db/client.js';
import { getSupabaseKeyDiagnostics } from '../db/supabaseKeyDiagnostics.js';
import { CSV_UPLOADS_BUCKET } from '../db/storage.js';
import { isSandboxMode } from '../db/sandboxClient.js';
import { isValidCsvUploadObjectName } from '../candidate/csvUploadValidation.js';
import { SubmissionQueueDaemon } from '../submitter/queueWorker.js';
import {
  demoApplication,
  demoSegment,
  demoTemplate,
  loadSecondaryDemoArtifacts,
} from '../dashboard/demoFixtures.js';
import { otpResolutionService } from '../services/otpResolutionService.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Server');

/**
 * Global metrics and pipeline status.
 */
export interface DashboardStats {
  totalCandidates: number;
  totalApplications: number | null;
  submitted: number | null;
  submittedCount: number | null;
  applied: number | null;
  failed: number | null;
  successfulApplications: number | null;
  failedApplications: number | null;
  statsAvailable: boolean;
  statsPartial: boolean;
  statsAvailableFrom: string;
  dateRange?: {
    preset: string;
    from: string | null;
    to: string | null;
    label: string;
  };
}

export interface LoadArtifactsOptions {
  /** Emit the single-line startup summary (default: false). */
  log?: boolean;
}

/**
 * Loads generated artifact files from disk into the in-memory artifact cache.
 * Call once at server startup; use POST /api/admin/refresh-artifacts to reload manually.
 */
export function loadArtifacts(
  _outputDir: string = config.OUTPUT_DIR,
  options: LoadArtifactsOptions = {}
): void {
  // V2+: Supabase is authoritative. Artifact cache holds demo fixtures only.
  const secondaryDemo = loadSecondaryDemoArtifacts();
  const secondarySegment = secondaryDemo.segment;
  const secondaryApplications = secondaryDemo.applications;
  const secondaryTemplates = secondaryDemo.templates;

  const pinnedSegments: CandidateSegment[] = [demoSegment];
  if (secondarySegment) {
    pinnedSegments.push(secondarySegment);
  }

  const pinnedApplications: CandidateJobApplication[] = [demoApplication, ...secondaryApplications];

  artifactCache.candidateSegments = pinnedSegments;
  artifactCache.scannedJobs = [demoTemplate, ...secondaryTemplates];
  artifactCache.resolvedApplications = pinnedApplications;
  artifactCache.lastLoadedAt = new Date().toISOString();

  rebuildLookupMaps();

  if (options.log) {
    log.info(
      `[Server] ✅ Artifacts initialized: V2 Supabase mode active (demo fixtures ready)`
    );
  }
}

/**
 * Creates and configures the Express application instance.
 *
 * @returns Configured Express application.
 */
export function createServer(outputDir: string = config.OUTPUT_DIR): express.Application {
  const isIngestOnly = config.INGEST_ONLY === 'true' || process.env.INGEST_ONLY === 'true';

  if (isIngestOnly) {
    log.info('[Server] Starting in INGEST_ONLY mode');
    const app = express();
    app.use(
      cors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') ?? false,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Authorization',
          'Content-Type',
          'X-View-As',
          'X-View-As-Manager-Email',
          'X-Dashboard-Date-Range',
          'X-Work-History-Unreachable',
        ],
      })
    );
    app.use(express.json());

    /**
     * GET /api/health
     * Health check endpoint.
     */
    app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'greenhouse-operator-api',
        mode: 'ingest-only',
        timestamp: new Date().toISOString(),
      });
    });

    /**
     * POST /api/admin/trigger-ingest-from-storage
     * Ingests newly uploaded CSV files from the Supabase Storage dropzone.
     */
    app.post('/api/admin/trigger-ingest-from-storage', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
      if (!isUserAdmin(req.user || getAuthenticatedCaEmail(req))) {
        res.status(403).json({ error: 'Forbidden: only admins can start the pipeline.' });
        return;
      }
      const requestedFileName = req.body && typeof req.body === 'object' ? req.body.fileName : undefined;
      if (requestedFileName !== undefined && (
        typeof requestedFileName !== 'string' || !isValidCsvUploadObjectName(requestedFileName)
      )) {
        res.status(400).json({ error: 'Invalid CSV upload object name.' });
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
      const actorEmail = getAuthenticatedCaEmail(req) || (req.user as { email?: string } | undefined)?.email || '';
      void insertAuditEvent({
        actorEmail,
        actorRole: resolveRole(req.user || actorEmail),
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
        const { ingestCsvFromStorage } = await import('../scanner/storageCsvIngestion.js');
        const result = await ingestCsvFromStorage({
          runId,
          triggeredBy: actorEmail,
          fileName: requestedFileName,
        });
        setIngestRun({
          running: false,
          startedAt,
          finishedAt: new Date().toISOString(),
          processedCount: result.processedCount,
          processedFile: result.processedFile,
          message: result.success ? result.message : result.aborted ? 'Pipeline stopped by operator.' : undefined,
          error: result.success ? undefined : result.message,
          notificationError: result.notificationError,
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
        const message = err.message || 'Storage ingestion failed';
        setIngestRun({
          running: false,
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
    });

    /**
     * POST /api/admin/stop-ingest
     * Requests cooperative stop of the in-flight storage CSV pipeline (admin; enabled on Railway/dev).
     */
    app.post('/api/admin/stop-ingest', requireAuth, (req: AuthenticatedRequest, res: Response) => {
      if (!isUserAdmin(req.user || getAuthenticatedCaEmail(req))) {
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

      setIngestRun({
        ...currentRun,
        running: false,
        status: 'stopped',
        finishedAt: stoppedAt,
        message: 'Pipeline stopped by operator.',
      });

      if (runId) {
        void upsertIngestRun({
          id: runId,
          status: 'stopped',
          finished_at: stoppedAt,
          phase: 'Aborted',
          message: 'Pipeline stopped by operator.',
        });
      }

      res.json({ stopping: true, ...getIngestRun() });
    });

    /**
     * GET /api/admin/ingest-status
     * Reports the state of the most recent storage CSV ingestion run.
     */
    app.get('/api/admin/ingest-status', requireAuth, (req: AuthenticatedRequest, res: Response) => {
      if (!isUserAdmin(req.user || getAuthenticatedCaEmail(req))) {
        res.status(403).json({ error: 'Forbidden: only admins can view ingestion status.' });
        return;
      }
      res.json({ ...getIngestRun(), stopEnabled: isPipelineStopEnabled() });
    });

    /**
     * Local Sandbox Storage File Serving
     * Serves locally uploaded resumes, proofs, and csvs in sandbox mode.
     */
    app.get('/api/sandbox/storage/:bucket/*', (req: Request, res: Response) => {
      if (!isSandboxMode()) {
        res.status(404).send('Not found');
        return;
      }
      const bucket = String(req.params.bucket || '');
      const rawParam = (req.params as any)[0];
      const objectPath = Array.isArray(rawParam) ? rawParam.join('/') : String(rawParam || '');
      const baseDir = process.env.SANDBOX_STORAGE_DIR
        ? path.resolve(process.env.SANDBOX_STORAGE_DIR)
        : path.resolve(process.cwd(), 'storage_sandbox');
      const storageRoot = path.resolve(baseDir);
      const fullPath = path.resolve(storageRoot, bucket, objectPath);
      const relativePath = path.relative(storageRoot, fullPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        res.status(400).send('Invalid storage path');
        return;
      }
      if (fs.existsSync(fullPath)) {
        res.sendFile(fullPath);
      } else {
        res.status(404).send('File not found in sandbox storage');
      }
    });

    return app;
  }

  loadArtifacts(outputDir, { log: true });
  const app = express();

  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGINS?.split(',') ?? false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-View-As',
        'X-View-As-Manager-Email',
        'X-Dashboard-Date-Range',
        'X-Work-History-Unreachable',
      ],
    })
  );
  app.use(express.json());

  // Static directory for master resume PDFs
  const resumesDir = path.resolve(process.cwd(), config.RESUMES_DIR);
  if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
  }
  app.use('/resumes', express.static(resumesDir));

  // Dashboard web assets — TSX/Vite dist only
  const distDashboardDir = path.resolve(process.cwd(), 'dist/client');
  const distDashboardIndexPath = path.join(distDashboardDir, 'index.html');
  const distManagerIndexPath = path.join(distDashboardDir, 'manager/index.html');
  const distAdminIndexPath = path.join(distDashboardDir, 'admin/index.html');
  const distDevIndexPath = path.join(distDashboardDir, 'dev/index.html');

  app.use(express.static(distDashboardDir, { index: false }));

  app.get('/', requireRoleIfAuthenticated('operator', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(distDashboardIndexPath)) {
      res.sendFile(distDashboardIndexPath);
    } else {
      res.status(503).send('Dashboard bundle not found. Run npm run build:dashboard.');
    }
  });

  app.get('/admin', requireRoleIfAuthenticated('admin', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(distAdminIndexPath)) {
      res.sendFile(distAdminIndexPath);
    } else {
      res.status(503).send('Admin dashboard bundle not found. Run npm run build:dashboard.');
    }
  });

  app.get('/manager', requireRoleIfAuthenticated('manager', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(distManagerIndexPath)) {
      res.sendFile(distManagerIndexPath);
    } else {
      res.status(503).send('Manager dashboard bundle not found. Run npm run build:dashboard.');
    }
  });

  app.get('/dev', requireRoleIfAuthenticated('dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(distDevIndexPath)) {
      res.sendFile(distDevIndexPath);
    } else {
      res.status(503).send('Dev dashboard bundle not found. Run npm run build:dashboard.');
    }
  });

  app.use('/dev/db', requireRoleIfAuthenticated('dev'), devDbRouter);

  // Favicon / logo / other public assets (static images, CSS).
  const publicDir = path.resolve(process.cwd(), 'dashboard/public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false }));
  }

  const operatorApiGuard = [requireAuth, requireOperatorDashboardAccess] as const;
  const candidateListApiGuard = [requireAuth, requireRole('operator', 'manager', 'admin', 'dev')] as const;
  const usersApiGuard = [requireAuth, requireRole('manager', 'admin', 'dev')] as const;
  const adminApiGuard = [requireAuth, requireRole('admin', 'dev')] as const;
  const managerApiGuard = [requireAuth, requireRole('manager', 'dev')] as const;
  const devApiGuard = [requireAuth, requireRole('dev')] as const;

  // Auth routes (public)
  app.use('/api/auth', authRouter);

  // Applications, field patch, dry-run, and submission routes (protected)
  app.use('/api/applications', ...operatorApiGuard, submissionsRouter);
  app.use('/api/applications', ...operatorApiGuard, applicationsRouter);

  // Real events notifications routes (protected)
  app.use('/api/notifications', ...operatorApiGuard, notificationsRouter);

  // Dashboard client config (protected)
  app.use('/api/config', ...operatorApiGuard, configRouter);

  // Manager dashboard API
  app.use('/api/manager', ...managerApiGuard, managerRouter);

  // Operator candidate queue + admin namespace
  app.use('/api/candidates', ...candidateListApiGuard, candidatesRouter);
  app.use('/api/users', ...usersApiGuard, usersRouter);
  app.use('/api/admin', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && req.path === '/ingest-status') {
      requireAuth(req, res, next);
      return;
    }
    adminApiGuard[0](req, res, () => {
      adminApiGuard[1](req, res, next);
    });
  });
  app.use('/api/dev', ...devApiGuard, devDashboardRouter);

  function validateInternalSecret(req: Request, res: Response, next: NextFunction): void {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        res.status(401).json({ success: false, error: 'Unauthorized: INTERNAL_API_SECRET is required' });
        return;
      }
      return next();
    }
    const provided = req.headers['x-internal-secret'];
    if (!provided || typeof provided !== 'string') {
      res.status(401).json({ success: false, error: 'Unauthorized: missing or invalid x-internal-secret header' });
      return;
    }
    try {
      const bufA = Buffer.from(provided);
      const bufB = Buffer.from(secret);
      if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
        res.status(401).json({ success: false, error: 'Unauthorized: secret mismatch' });
        return;
      }
    } catch {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    next();
  }

  // Internal cross-service WebSocket broadcast receiver
  app.post('/api/internal/ws-broadcast', validateInternalSecret, (req: Request, res: Response): void => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1');
    const isPublic = Boolean(req.headers['x-forwarded-for']);

    if (isPublic && !isLoopback && !req.headers['x-internal-secret']) {
      const role = (req as any).user?.role;
      if (role !== 'admin' && role !== 'dev') {
        res.status(403).json({ success: false, error: 'Internal or admin access only' });
        return;
      }
    }

    try {
      wsManager.broadcast(req.body);
      res.json({ success: true });
    } catch (err: any) {
      log.error('[Internal] ws-broadcast error:', err);
      res.status(500).json({ success: false, error: err?.message });
    }
  });

  if (process.env.ENABLE_QUEUE_WORKER === 'true') {
    app.post('/api/internal/applications/:id/submit-otp', validateInternalSecret, async (req: Request, res: Response): Promise<void> => {
      const rawId = req.params.id;
      const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
      const otp = req.body?.otp;
      if (!otp || typeof otp !== 'string' || !otp.trim()) {
        res.status(400).json({ success: false, error: 'Missing required body field: otp (string).' });
        return;
      }
      try {
        const { submitOtpToPausedSession } = await import('../submitter/liveSubmit.js');
        const result = await submitOtpToPausedSession(appId, otp.trim(), {
          timeoutMs: req.body?.timeoutMs ?? 30000,
          confirmationTimeoutMs: req.body?.confirmationTimeoutMs,
          jobUrl: req.body?.jobUrl,
        });
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message || 'Failed to submit OTP' });
      }
    });

    app.get('/api/internal/worker-status', validateInternalSecret, (_req: Request, res: Response): void => {
      const daemon = getQueueDaemon();
      if (daemon) {
        res.json(daemon.getSnapshot());
      } else {
        res.json({
          running: false,
          workerCount: 0,
          idleCount: 0,
          pendingAssignments: 0,
          inFlightCount: 0,
          inFlightIds: [],
          laneLengths: [],
        });
      }
    });
  }

  /**
   * GET /api/health
   * Health check endpoint.
   */
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'greenhouse-operator-api',
      timestamp: new Date().toISOString(),
      loaded: {
        candidates: artifactCache.candidateSegments.length,
        templates: artifactCache.scannedJobs.length,
        applications: artifactCache.resolvedApplications.length,
        lastLoadedAt: artifactCache.lastLoadedAt,
      },
    });
  });

  /**
   * GET /api/stats
   * Returns aggregated dashboard metrics.
   */
  app.get('/api/stats', ...candidateListApiGuard, async (req: Request, res: Response) => {
    const parsedRange = parseDashboardStatsRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }

    const createdAtRange = { startIso: parsedRange.startIso, endIso: parsedRange.endIso };
    const authReq = req as AuthenticatedRequest;
    const userEmail = getAuthenticatedCaEmail(authReq);
    const role = resolveRequestAppRole(authReq, userEmail);
    const viewAsManagerEmail = resolveViewAsOperatorManagerEmail(authReq);
    const unrestricted = hasUnrestrictedDashboardAccess(role) && !viewAsManagerEmail;

    let allowedCandidateIds: string[] | undefined = undefined;
    if (!unrestricted) {
      if (!userEmail && !viewAsManagerEmail) {
        log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
      if (viewAsManagerEmail) {
        const team = await resolveTeamCandidateIdsForManager(
          viewAsManagerEmail,
          istDatesForWorkHistory(parsedRange),
          createdAtRange
        );
        allowedCandidateIds = team.candidateIds;
      } else if (role === 'manager') {
        const team = await resolveTeamCandidateIdsForManager(
          userEmail!,
          istDatesForWorkHistory(parsedRange),
          createdAtRange
        );
        allowedCandidateIds = team.candidateIds;
      } else {
        const merged = await mergeWorkHistoryForIstDates({
          mode: 'ca',
          caEmail: userEmail!,
          dates: istDatesForWorkHistory(parsedRange),
        });
        allowedCandidateIds = merged.candidateIds;
      }
    }

    const statsScope = unrestricted
      ? {}
      : viewAsManagerEmail || role === 'manager'
        ? { managerEmail: viewAsManagerEmail || userEmail || undefined }
        : { caEmail: userEmail || undefined };
    let applicationStats;
    try {
      applicationStats = await getApplicationStats({
        range: { fromDate: parsedRange.fromDate!, toDate: parsedRange.toDate! },
        scope: statsScope,
      });
    } catch (error) {
      log.error('[Stats] Failed to load canonical application statistics:', error);
      res.status(500).json({ error: 'Unable to load application statistics.' });
      return;
    }

    const metrics = await getDashboardApplicationMetrics({
      createdAtRange,
      allowedCandidateIds,
    });

    const stats: DashboardStats = {
      totalCandidates: metrics.totalCandidates,
      totalApplications: applicationStats.counts.total,
      submitted: applicationStats.counts.submitted,
      submittedCount: applicationStats.counts.submitted,
      applied: applicationStats.counts.applied,
      successfulApplications: applicationStats.counts.applied,
      failed: applicationStats.counts.failed,
      failedApplications: applicationStats.counts.failed,
      statsAvailable: applicationStats.available,
      statsPartial: applicationStats.partial,
      statsAvailableFrom: applicationStats.availableFrom,
      dateRange: serializeDateRange(parsedRange),
    };

    res.json(stats);
  });

  /**
   * POST /api/admin/refresh-artifacts
   * Manually reloads pipeline artifacts from disk into memory.
   */
  app.post('/api/admin/refresh-artifacts', (_req: Request, res: Response) => {
    loadArtifacts(outputDir);
    res.json({ reloaded: true, timestamp: artifactCache.lastLoadedAt, message: 'V2 uses direct database queries' });
  });


  /**
   * GET /api/admin/supabase-storage-health
   * Safe credential + bucket probe for debugging Railway env (no secrets returned).
   */
  app.get('/api/admin/supabase-storage-health', async (req: AuthenticatedRequest, res: Response) => {
    if (!isUserAdmin(req.user || getAuthenticatedCaEmail(req))) {
      res.status(403).json({ error: 'Forbidden: only admins can view storage health.' });
      return;
    }
    if (!isSupabaseConfigured()) {
      res.json({ configured: false, message: 'SUPABASE_URL and a service key are missing.' });
      return;
    }
    const { url, serviceKey, serviceKeySource } = resolveSupabaseCredentials();
    const diagnostics = getSupabaseKeyDiagnostics(url, serviceKey);
    const { candidates } = listSupabaseKeyCandidates();
    const keyProbes = [];
    for (const candidate of candidates) {
      const diag = getSupabaseKeyDiagnostics(url, candidate.key);
      const client = createSupabaseServerClient(url, candidate.key);
      const { data: listed, error: csvProbeError } = await client.storage
        .from(CSV_UPLOADS_BUCKET)
        .list('', { limit: 100, offset: 0 });
      const { data: buckets, error: bucketsError } = await client.storage.listBuckets();
      keyProbes.push({
        source: candidate.source,
        jwtRole: diag.jwtRole,
        keyShape: diag.keyShape,
        urlRefMatch: diag.urlRefMatch,
        listBucketsError: bucketsError?.message ?? null,
        visibleBuckets: (buckets || []).map((b) => b.name),
        csvUploadsListNames: (listed || []).map((f) => f.name),
        csvUploadsDirectListError: csvProbeError?.message ?? null,
      });
    }
    res.json({
      configured: true,
      serviceKeySource,
      diagnostics: diagnostics.summary,
      jwtRole: diagnostics.jwtRole,
      urlRefMatch: diagnostics.urlRefMatch,
      keyProbes,
    });
  });

  app.use('/api/admin', adminDashboardRouter);

  /**
   * Catch-all route serving the dashboard SPA index.html.
   */
  app.get('*', requireRoleIfAuthenticated('operator', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(distDashboardIndexPath)) {
      res.sendFile(distDashboardIndexPath);
    } else {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Greenhouse Automation API</title></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #FFF5EB; color: #1E293B; padding: 2rem;">
          <h1 style="color: #1A1A2E;">🟢 Greenhouse Job Application Automation API (Port ${config.PORT})</h1>
          <p style="color: #64748B;">API Server is running. Endpoints:</p>
          <ul>
            <li><a style="color: #0284C7;" href="/api/stats">GET /api/stats</a></li>
            <li><a style="color: #0284C7;" href="/api/candidates">GET /api/candidates</a></li>
            <li><a style="color: #0284C7;" href="/api/health">GET /api/health</a></li>
          </ul>
        </body>
        </html>
      `);
    }
  });

  return app;
}

/**
 * Starts the Express REST API server.
 *
 * @param port - Port to listen on (defaults to `config.PORT` or `3001`).
 * @returns Running HTTP server instance.
 */
export function startServer(
  port: number = process.env.PORT ? parseInt(process.env.PORT, 10) : (config.PORT || 3000)
): ReturnType<express.Application['listen']> {
  const isIngestOnly = config.INGEST_ONLY === 'true' || process.env.INGEST_ONLY === 'true';
  startFailureDiagnosticsRetention();
  const app = createServer();

  const server = app.listen(port, '0.0.0.0', () => {
    if (isIngestOnly) {
      log.info('================================================================');
      log.info(`  🟢 Greenhouse INGEST-ONLY Service Live on 0.0.0.0:${port}`);
      log.info('================================================================');
      log.info(`• Mode:               INGEST_ONLY`);
      log.info(`• Health:             /api/health`);
      log.info(`• Trigger Ingest:     POST /api/admin/trigger-ingest-from-storage`);
      log.info(`• Stop Ingest:        POST /api/admin/stop-ingest`);
      log.info(`• Ingest Status:      GET /api/admin/ingest-status`);
      log.info('================================================================\n');

      logSupabaseCredentialIdentity('Server');
      return;
    }

    wsManager.init(server);
    log.info('================================================================');
    log.info(`  🟢 Greenhouse Operator REST API & Dashboard Live on 0.0.0.0:${port}`);
    log.info('================================================================');
    log.info(`• URL:                http://0.0.0.0:${port}`);
    log.info(`• Candidate Stats:    /api/stats`);
    log.info(`• Candidate List:     /api/candidates`);
    log.info(`• Master Resumes:     /resumes/`);
    log.info('================================================================\n');

    logSupabaseCredentialIdentity('Server');

    const workerServiceUrl = (process.env.WORKER_SERVICE_URL || config.WORKER_SERVICE_URL || '').trim();
    if (!workerServiceUrl) {
      log.warn('[Server] WORKER_SERVICE_URL not set — submit/dry-run will execute in-process (no worker service).');
    } else {
      log.info(`[Server] WORKER_SERVICE_URL configured: ${workerServiceUrl} — submit/dry-run will proxy to worker service.`);
    }

    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      // Start fast REST API-based OTP resolution service immediately
      otpResolutionService.start();

    }

    // Sweep stale in-flight applications (OTP_REQUIRED/APPLYING >10m) on startup
    void sweepStaleApplications().catch((err) => {
      log.error(`[Server] Stale sweep on startup failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Periodically sweep stale/disconnected browser processes every 60 seconds
    const browserSweepInterval = setInterval(() => {
      void browserManager.cleanupStaleBrowsers().catch((err) => {
        log.warn(`[Server] Browser cleanup sweep warning: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 60 * 1000);
    if (browserSweepInterval.unref) {
      browserSweepInterval.unref();
    }

    // Launch background round-robin submission worker daemon if enabled (Phase V2-4c)
    let queueDaemon: SubmissionQueueDaemon | null = null;
    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      const concurrency = process.env.WORKER_CONCURRENCY ? parseInt(process.env.WORKER_CONCURRENCY, 10) : 3;
      log.info(
        `[Queue] ENABLE_QUEUE_WORKER=true — starting SubmissionQueueDaemon (WORKER_CONCURRENCY=${concurrency}, dequeue status=QUEUED)`
      );
      queueDaemon = new SubmissionQueueDaemon({ concurrency });
      registerQueueDaemon(queueDaemon);
      queueDaemon.start();
    } else {
      log.warn(
        '[Queue] ENABLE_QUEUE_WORKER is not "true" — POST /submit will set status=QUEUED but no in-process worker will run'
      );
    }
  });

  const cleanup = async () => {
    otpResolutionService.stop();
    await sweepStaleApplications().catch(() => {});
    await browserManager.closeAll().catch(() => {});
    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      // Allow in-flight Playwright workers to finish
      log.info('[Server] 🧹 Shutting down background queue daemon...');
    }
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  return server;
}

// Auto-start when executed directly
if (process.argv[1] && process.argv[1].includes('server')) {
  startServer();
}
