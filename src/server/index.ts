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

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { upsertIngestRun } from '../db/ingestRuns.js';
import { config } from '../config/env.js';
import { resolveShortlink } from '../scanner/csvDeduplicator.js';
import { applicationsRouter } from './routes/applications.js';
import { submissionsRouter } from './routes/submissions.js';
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
import {
  ADMIN_WORK_HISTORY_CACHE_KEY,
  type WorkHistoryCandidateRecord,
} from '../services/workHistoryClient.js';
import { hydrateAdminProfilesFromWorkHistory } from '../services/adminProfileHydrate.js';
import {
  cacheApplicationLocally,
  applyCreatedAtRangeFilter,
  getSubmissionOutcomeCounts,
  getDashboardApplicationMetrics,
  countSubmittedApplicationsSince,
  countAppliedApplicationsSince,
  getApplication,
  upsertApplication,
  serializeApplicationDto,
  hydrateAndPersistApplicationFields,
  hydrateApplicationProofUrls,
  fetchCandidateApplicationAggregatesByApplywizzIds,
  distinctApplywizzIdsForCreatedAtRange,
  type ApplicationRow,
  type CandidateQueueStatus,
} from '../db/applications.js';
import {
  istDatesForWorkHistory,
  parseDashboardCreatedAtRange,
  serializeDateRange,
} from './dashboardDateRange.js';
import { sanitizeHttpHeaderValue } from './httpHeaders.js';
import { mergeWorkHistoryForIstDates } from './workHistorySpan.js';
import {
  applicationAssignedCaAllowedForRequest,
  hasUnrestrictedDashboardAccess,
  isApplywizzIdInDashboardAccess,
  resolveDashboardCandidateAccess,
  resolveRequestAppRole,
  resolveTeamCandidateIdsForManager,
  resolveViewAsOperatorManagerEmail,
} from './managerTeamScope.js';
import {
  computeEligibleForSubmissionDisplay,
  parseCsvJobScore,
} from '../submission/submissionEligibilityGate.js';
import { usersRouter } from './routes/users.js';
import { applicationRowHasPersistedResolution } from '../dashboard/candidateQueueFilter.js';
import { fetchProfileListingFieldsByApplywizzIds } from '../db/profiles.js';
import { fetchResumePdfBuffer, getProfileResumeHttpUrl, isDemoResumeApplywizzId } from '../db/storage.js';
import { isSupabaseConfigured, getDbClient, logSupabaseCredentialIdentity, resolveSupabaseCredentials, listSupabaseKeyCandidates, createSupabaseServerClient } from '../db/client.js';
import { getSupabaseKeyDiagnostics } from '../db/supabaseKeyDiagnostics.js';
import { CSV_UPLOADS_BUCKET } from '../db/storage.js';
import {
  assertApplywizzZohoConnected,
  fetchZohoConnectedApplywizzIdSet,
} from '../db/zohoConnected.js';
import { SubmissionQueueDaemon } from '../submitter/queueWorker.js';
import {
  demoApplication,
  demoSegment,
  demoTemplate,
  toApplicationRow,
  mergeDemoFixtures,
  DEMO_APPLYWIZZ_ID,
  DEMO_JOB_URL,
  AKSHITHA_APPLYWIZZ_ID,
  loadSecondaryDemoArtifacts,
  inMemoryDemoJobRowsForDashboard,
} from '../dashboard/demoFixtures.js';
import { zohoReader } from '../services/zohoReader.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedJobTemplate,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Server');

const ACTIVE_CANDIDATES_LOG_INTERVAL_MS = 10 * 60 * 1000;
const lastActiveCandidatesLogByCa = new Map<string, number>();

function logActiveCandidatesThrottled(caEmail: string, count: number): void {
  const key = caEmail.trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  const last = lastActiveCandidatesLogByCa.get(key) ?? 0;
  if (now - last < ACTIVE_CANDIDATES_LOG_INTERVAL_MS) return;
  lastActiveCandidatesLogByCa.set(key, now);
  log.info(`[Dashboard] Active candidates: ${count} assigned to ${key}`);
}

/**
 * Summary representation of a candidate for the directory listing.
 */
export interface CandidateSummary {
  applywizzId: string;
  clientName: string;
  email: string;
  location: string;
  totalJobs: number;
  job_count: number;
  queue_status: CandidateQueueStatus;
  readyCount: number;
  expiredCount: number;
  status: 'READY' | 'PENDING' | 'EXPIRED';
  syncedAt?: string;
  resumeAvailable: boolean;
}

function applyApplicationAggregatesToSummaries(
  summaries: CandidateSummary[],
  aggregates: Map<string, { job_count: number; queue_status: CandidateQueueStatus }>
): CandidateSummary[] {
  return summaries.map((summary) => {
    const agg = aggregates.get(summary.applywizzId.trim().toUpperCase());
    const job_count = agg?.job_count ?? 0;
    const queue_status = agg?.queue_status ?? 'NO_APPLICATIONS';
    return {
      ...summary,
      job_count,
      queue_status,
      totalJobs: job_count,
    };
  });
}

/**
 * Global metrics and pipeline status.
 */
export interface DashboardStats {
  totalCandidates: number;
  totalApplications: number;
  submitted: number;
  applied: number;
  failed: number;
  dateRange?: {
    preset: string;
    from: string | null;
    to: string | null;
    label: string;
  };
}

/**
 * In-memory artifact cache loaded once at server startup (refreshed via admin endpoint).
 */
export interface ArtifactCache {
  candidateSegments: CandidateSegment[];
  scannedJobs: ScannedJobTemplate[];
  resolvedApplications: CandidateJobApplication[];
  lastLoadedAt: string | null;
}

function isDashboardDemoFixtureJob(
  applywizzId: string,
  job: { canonicalUrl?: string; rawUrl?: string }
): boolean {
  return (
    applywizzId === DEMO_APPLYWIZZ_ID ||
    applywizzId === AKSHITHA_APPLYWIZZ_ID ||
    job.canonicalUrl === DEMO_JOB_URL ||
    job.rawUrl === DEMO_JOB_URL
  );
}

function isPinnedDemoApplywizzId(applywizzId: string): boolean {
  const id = applywizzId.trim().toUpperCase();
  return id === DEMO_APPLYWIZZ_ID.toUpperCase() || id === AKSHITHA_APPLYWIZZ_ID.toUpperCase();
}

/** In-memory demo fixtures (AWL-YASWANTH / AWL-31428) are for dev/admin preview only. */
function mayServeInMemoryDemoFixtures(unrestricted: boolean): boolean {
  return unrestricted;
}

function dashboardJobUrlKey(job: { rawUrl?: string; canonicalUrl?: string }): string {
  return (job.canonicalUrl || job.rawUrl || '').trim().toLowerCase();
}

function mergeDashboardJobsByUrl(
  primary: Array<Record<string, unknown>>,
  additions: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const job of [...primary, ...additions]) {
    const key = dashboardJobUrlKey(job as { rawUrl?: string; canonicalUrl?: string });
    if (!key) continue;
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, ...job } : job);
  }
  return Array.from(map.values());
}

function resolvedApplicationsToJobRows(applywizzId: string): Array<Record<string, unknown>> {
  return artifactCache.resolvedApplications
    .filter((application) => application.applywizzId === applywizzId)
    .map((application) => ({
      rawUrl: application.jobUrl,
      canonicalUrl: application.jobUrl,
      companyName: application.companyName || 'Greenhouse Company',
      jobTitle: application.jobTitle || 'Job Opening',
      status: application.status || 'PENDING',
      fieldsCount: application.resolvedFields?.length || 0,
      hasManualEdits: Boolean((application as any).hasManualEdits || (application as any).has_manual_edits),
    }));
}

function segmentToJobRows(segment: CandidateSegment | undefined): Array<Record<string, unknown>> {
  if (!segment) return [];
  return segment.jobs.map((job) => {
    const jobUrl = job.canonicalUrl || job.rawUrl;
    const template = templatesMap.get(jobUrl) || templatesMap.get(job.rawUrl);
    return {
      rawUrl: job.rawUrl,
      canonicalUrl: jobUrl,
      companyName: template?.companyName || 'Greenhouse Company',
      jobTitle: template?.jobTitle || 'Job Opening',
      status: template?.isExpired ? 'EXPIRED' : 'PENDING',
      fieldsCount: template?.fields?.length || 0,
      hasManualEdits: false,
      score: job.score,
    };
  });
}

function resolvePinnedDemoSegment(applywizzId: string): CandidateSegment | undefined {
  return (
    candidatesMap.get(applywizzId) ||
    (applywizzId === DEMO_APPLYWIZZ_ID
      ? demoSegment
      : applywizzId === AKSHITHA_APPLYWIZZ_ID
        ? loadSecondaryDemoArtifacts().segment ?? undefined
        : undefined)
  );
}

export const artifactCache: ArtifactCache = {
  candidateSegments: [],
  scannedJobs: [],
  resolvedApplications: [],
  lastLoadedAt: null,
};

/** O(1) lookup maps rebuilt whenever artifacts are loaded. */
const candidatesMap = new Map<string, CandidateSegment>();
const templatesMap = new Map<string, ScannedJobTemplate>();
const applicationsMap = new Map<string, CandidateJobApplication>();

function rebuildLookupMaps(): void {
  candidatesMap.clear();
  templatesMap.clear();
  applicationsMap.clear();

  for (const seg of artifactCache.candidateSegments) {
    candidatesMap.set(seg.applywizzId, seg);
  }
  for (const template of artifactCache.scannedJobs) {
    templatesMap.set(template.jobUrl, template);
  }
  for (const app of artifactCache.resolvedApplications) {
    const key = `${app.applywizzId}::${app.jobUrl}`;
    applicationsMap.set(key, app);
    cacheApplicationLocally(toApplicationRow(app));
  }
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
  outputDir: string = config.OUTPUT_DIR,
  options: LoadArtifactsOptions = {}
): void {
  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);

  const segmentsPath = path.join(resolvedOutputDir, 'candidate_segments.json');
  const templatesPath = path.join(resolvedOutputDir, 'scanned_jobs.json');
  const applicationsPath = path.join(resolvedOutputDir, 'resolved_applications.json');

  let segments: CandidateSegment[] = [];
  let templates: ScannedJobTemplate[] = [];
  let applications: CandidateJobApplication[] = [];

  if (fs.existsSync(segmentsPath)) {
    try {
      segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
    } catch (err: any) {
      log.warn(`[Server] ⚠️ Failed to read ${segmentsPath}: ${err.message}`);
    }
  }

  if (fs.existsSync(templatesPath)) {
    try {
      templates = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'));
    } catch (err: any) {
      log.warn(`[Server] ⚠️ Failed to read ${templatesPath}: ${err.message}`);
    }
  }

  if (fs.existsSync(applicationsPath)) {
    try {
      applications = JSON.parse(fs.readFileSync(applicationsPath, 'utf-8'));
    } catch (err: any) {
      log.warn(`[Server] ⚠️ Failed to read ${applicationsPath}: ${err.message}`);
    }
  }

  const secondaryDemo = loadSecondaryDemoArtifacts();
  const secondarySegment = secondaryDemo.segment;
  const secondaryApplications = secondaryDemo.applications;
  const secondaryTemplates = secondaryDemo.templates;

  const pinnedSegments: CandidateSegment[] = [demoSegment];
  if (secondarySegment) {
    pinnedSegments.push(secondarySegment);
  }
  const pinnedApplywizzIds = new Set(pinnedSegments.map((s) => s.applywizzId));

  const pinnedApplications: CandidateJobApplication[] = [demoApplication, ...secondaryApplications];
  const pinnedApplicationKeys = new Set(
    pinnedApplications.map((a) => `${a.applywizzId}::${a.jobUrl}`)
  );
  const pinnedTemplateUrls = new Set([demoTemplate.jobUrl, ...secondaryTemplates.map((t) => t.jobUrl)]);

  artifactCache.candidateSegments = mergeDemoFixtures(
    [
      ...pinnedSegments,
      ...segments.filter((s) => !pinnedApplywizzIds.has(s.applywizzId)),
    ],
    pinnedSegments,
    (s) => s.applywizzId
  );
  artifactCache.scannedJobs = mergeDemoFixtures(
    [
      demoTemplate,
      ...secondaryTemplates,
      ...templates.filter((t) => !pinnedTemplateUrls.has(t.jobUrl)),
    ],
    [demoTemplate, ...secondaryTemplates],
    (t) => t.jobUrl
  );
  artifactCache.resolvedApplications = mergeDemoFixtures(
    [
      ...pinnedApplications,
      ...applications.filter((a) => !pinnedApplicationKeys.has(`${a.applywizzId}::${a.jobUrl}`)),
    ],
    pinnedApplications,
    (a) => `${a.applywizzId}::${a.jobUrl}`
  );
  artifactCache.lastLoadedAt = new Date().toISOString();

  rebuildLookupMaps();

  if (options.log) {
    log.info(
      `[Server] ✅ Artifacts loaded: ${artifactCache.candidateSegments.length} candidates, ${artifactCache.scannedJobs.length} templates, ${artifactCache.resolvedApplications.length} applications`
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
        const result = await ingestCsvFromStorage({ runId, triggeredBy: actorEmail });
        setIngestRun({
          running: false,
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

  // Dashboard web assets (HTML guarded by role when Bearer token is sent)
  const publicDir = path.resolve(process.cwd(), 'dashboard/public');
  const distDashboardDir = path.resolve(process.cwd(), 'dist/client');
  const operatorIndexPath = path.join(publicDir, 'index.html');
  const distDashboardIndexPath = path.join(distDashboardDir, 'index.html');
  const managerHtmlPath = path.join(publicDir, 'manager.html');
  const distManagerIndexPath = path.join(distDashboardDir, 'manager/index.html');
  const adminHtmlPath = path.join(publicDir, 'admin.html');
  const distAdminIndexPath = path.join(distDashboardDir, 'admin/index.html');
  const devHtmlPath = path.join(publicDir, 'dev.html');
  const distDevIndexPath = path.join(distDashboardDir, 'dev/index.html');

  const dashboardMode = (config.DASHBOARD_MODE ?? process.env.DASHBOARD_MODE ?? 'html').toLowerCase();

  if (dashboardMode === 'tsx') {
    app.use(express.static(distDashboardDir, { index: false }));
  }

  app.get('/', requireRoleIfAuthenticated('operator', 'dev'), (_req: Request, res: Response) => {
    if (dashboardMode === 'tsx') {
      if (fs.existsSync(distDashboardIndexPath)) {
        res.sendFile(distDashboardIndexPath);
        return;
      }
      log.warn('[Server] dist/client/index.html not found, falling back to public/index.html');
    }
    if (fs.existsSync(operatorIndexPath)) {
      res.sendFile(operatorIndexPath);
      return;
    }
    res.status(404).send('Operator dashboard page not found.');
  });

  app.get('/fallback', requireRoleIfAuthenticated('operator', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(operatorIndexPath)) {
      res.sendFile(operatorIndexPath);
      return;
    }
    res.status(404).send('Fallback operator dashboard page not found.');
  });

  app.get('/admin', requireRoleIfAuthenticated('admin', 'dev'), (_req: Request, res: Response) => {
    if (dashboardMode === 'tsx') {
      if (fs.existsSync(distAdminIndexPath)) {
        res.sendFile(distAdminIndexPath);
        return;
      }
      log.warn('[Server] dist/client/admin/index.html not found, falling back to public/admin.html');
    }
    if (fs.existsSync(adminHtmlPath)) {
      res.sendFile(adminHtmlPath);
      return;
    }
    res.status(404).send('Admin dashboard page not found.');
  });

  app.get('/admin/fallback', requireRoleIfAuthenticated('admin', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(adminHtmlPath)) {
      res.sendFile(adminHtmlPath);
      return;
    }
    res.status(404).send('Fallback admin dashboard page not found.');
  });

  app.get('/manager', requireRoleIfAuthenticated('manager', 'dev'), (_req: Request, res: Response) => {
    if (dashboardMode === 'tsx') {
      if (fs.existsSync(distManagerIndexPath)) {
        res.sendFile(distManagerIndexPath);
        return;
      }
      log.warn('[Server] dist/client/manager/index.html not found, falling back to public/manager.html');
    }
    if (fs.existsSync(managerHtmlPath)) {
      res.sendFile(managerHtmlPath);
      return;
    }
    res.status(404).send('Manager dashboard page not found.');
  });

  app.get('/manager/fallback', requireRoleIfAuthenticated('manager', 'dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(managerHtmlPath)) {
      res.sendFile(managerHtmlPath);
      return;
    }
    res.status(404).send('Fallback manager dashboard page not found.');
  });

  app.get('/dev', requireRoleIfAuthenticated('dev'), (_req: Request, res: Response) => {
    if (dashboardMode === 'tsx') {
      if (fs.existsSync(distDevIndexPath)) {
        res.sendFile(distDevIndexPath);
        return;
      }
      log.warn('[Server] dist/client/dev/index.html not found, falling back to public/dev.html');
    }
    if (fs.existsSync(devHtmlPath)) {
      res.sendFile(devHtmlPath);
      return;
    }
    res.status(404).send('Developer dashboard page not found.');
  });

  app.get('/dev/fallback', requireRoleIfAuthenticated('dev'), (_req: Request, res: Response) => {
    if (fs.existsSync(devHtmlPath)) {
      res.sendFile(devHtmlPath);
      return;
    }
    res.status(404).send('Fallback developer dashboard page not found.');
  });

  // Favicon / logo / other public assets. index:false so '/' stays on the guarded HTML routes.
  app.use(express.static(publicDir, { index: false }));

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
  app.use('/api/candidates', ...candidateListApiGuard);
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
          jobUrl: req.body?.jobUrl,
        });
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message || 'Failed to submit OTP' });
      }
    });

    app.post('/api/internal/applications/:id/resume-submission', validateInternalSecret, async (req: Request, res: Response): Promise<void> => {
      const rawId = req.params.id;
      const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
      try {
        const { resumeSubmission } = await import('../submitter/captchaResume.js');
        const result = await resumeSubmission(appId);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ success: false, error: err?.message || 'Failed to resume submission' });
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
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
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
    let submittedOperatorEmails: string[] | undefined;
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
        submittedOperatorEmails = team.operatorEmails;
      } else if (role === 'manager') {
        const team = await resolveTeamCandidateIdsForManager(
          userEmail!,
          istDatesForWorkHistory(parsedRange),
          createdAtRange
        );
        allowedCandidateIds = team.candidateIds;
        submittedOperatorEmails = team.operatorEmails;
      } else {
        const merged = await mergeWorkHistoryForIstDates({
          mode: 'ca',
          caEmail: userEmail!,
          dates: istDatesForWorkHistory(parsedRange),
        });
        allowedCandidateIds = merged.candidateIds;
        submittedOperatorEmails = userEmail ? [userEmail] : [];
      }
    }

    const [outcomes, submitted, applied] = await Promise.all([
      getSubmissionOutcomeCounts({
        createdAtRange,
        allowedCandidateIds,
      }),
      countSubmittedApplicationsSince(
        createdAtRange.startIso,
        unrestricted ? undefined : submittedOperatorEmails,
        createdAtRange.endIso
      ),
      countAppliedApplicationsSince(
        createdAtRange.startIso,
        unrestricted ? undefined : submittedOperatorEmails,
        createdAtRange.endIso
      ),
    ]);
    const metrics = await getDashboardApplicationMetrics({
      createdAtRange,
      allowedCandidateIds,
    });

    const stats: DashboardStats = {
      totalCandidates: metrics.totalCandidates,
      totalApplications: metrics.totalApplications,
      submitted,
      applied,
      failed: outcomes.failedApplications,
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
    res.json({ reloaded: true, timestamp: artifactCache.lastLoadedAt });
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
   * GET /api/candidates
   * Returns summary list of all segregated candidates with job counts and status for the selected IST date.
   */
  app.get('/api/candidates', async (req: AuthenticatedRequest, res: Response) => {
    const userEmail = getAuthenticatedCaEmail(req);
    const role = resolveRequestAppRole(req, userEmail);
    const viewAsManagerEmail = resolveViewAsOperatorManagerEmail(req);
    const unrestricted = hasUnrestrictedDashboardAccess(role) && !viewAsManagerEmail;

    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const whDates = istDatesForWorkHistory(parsedRange);

    let allowedIds: Set<string> | null = null;
    let workHistoryRecords: WorkHistoryCandidateRecord[] = [];
    let workHistoryUnreachable = false;
    let restrictedAccess: Awaited<ReturnType<typeof resolveDashboardCandidateAccess>> | null = null;

    if (unrestricted) {
      const merged = await mergeWorkHistoryForIstDates({
        mode: 'admin',
        caEmail: ADMIN_WORK_HISTORY_CACHE_KEY,
        dates: whDates,
      });
      try {
        await hydrateAdminProfilesFromWorkHistory(whDates[0]);
      } catch (hydrateErr: any) {
        log.warn('[Server] Admin profile hydration on candidates list failed:', hydrateErr?.message);
      }
      workHistoryUnreachable = merged.unreachable;
      workHistoryRecords = merged.records;
    } else {
      restrictedAccess = await resolveDashboardCandidateAccess(req, parsedRange, res);
      if (restrictedAccess.authError) {
        log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: restrictedAccess.authError });
        return;
      }
      workHistoryUnreachable = restrictedAccess.workHistoryUnreachable;
      workHistoryRecords = restrictedAccess.workHistoryRecords;
      allowedIds = restrictedAccess.allowedIds;
    }

    res.setHeader('X-Work-History-Unreachable', String(workHistoryUnreachable));
    res.setHeader('X-Dashboard-Date-Range', sanitizeHttpHeaderValue(parsedRange.label));

    let candidateSummaries: CandidateSummary[] = [];

    // Gather candidate IDs from workHistoryRecords
    const candidateMap = new Map<string, { applywizzId: string; clientName: string; email: string }>();
    if (workHistoryRecords.length > 0) {
      for (const rec of workHistoryRecords) {
        const idUpper = rec.applywizzId.toUpperCase();
        if (allowedIds && !allowedIds.has(idUpper)) continue;
        if (!mayServeInMemoryDemoFixtures(unrestricted) && isPinnedDemoApplywizzId(rec.applywizzId)) {
          continue;
        }
        candidateMap.set(idUpper, {
          applywizzId: rec.applywizzId,
          clientName: rec.clientName,
          email: rec.clientEmail,
        });
      }
    }

    // Supplement with database IDs for the date range
    let supplementalIds: string[] = [];
    if (unrestricted && isSupabaseConfigured()) {
      supplementalIds = await distinctApplywizzIdsForCreatedAtRange({
        startIso: parsedRange.startIso,
        endIso: parsedRange.endIso,
      });
    } else if (allowedIds && !unrestricted) {
      supplementalIds = [...allowedIds].filter((id) => !candidateMap.has(id.trim().toUpperCase()));
    }

    for (const rawId of supplementalIds) {
      const idUpper = rawId.trim().toUpperCase();
      if (!idUpper) continue;
      if (allowedIds && !allowedIds.has(idUpper)) continue;
      if (!mayServeInMemoryDemoFixtures(unrestricted) && isPinnedDemoApplywizzId(idUpper)) {
        continue;
      }
      if (!candidateMap.has(idUpper)) {
        candidateMap.set(idUpper, {
          applywizzId: rawId.trim(),
          clientName: rawId.trim(),
          email: '',
        });
      }
    }

    const allCandidateIds = Array.from(candidateMap.keys());
    const profileFields = await fetchProfileListingFieldsByApplywizzIds(allCandidateIds);

    for (const [idUpper, info] of candidateMap.entries()) {
      const fields = profileFields.get(idUpper);
      const applywizzId = fields?.applywizzId || info.applywizzId;
      const resumeAvailable = Boolean(
        fields?.resumeStoragePath ||
          (!isSupabaseConfigured() && fs.existsSync(path.join(config.RESUMES_DIR, `${applywizzId}_resume.pdf`)))
      );

      candidateSummaries.push({
        applywizzId,
        clientName: fields?.clientName || info.clientName || applywizzId,
        email: fields?.email || info.email || '',
        location: fields?.location || '',
        totalJobs: 0,
        job_count: 0,
        queue_status: 'NO_APPLICATIONS' as CandidateQueueStatus,
        readyCount: 0,
        expiredCount: 0,
        status: 'PENDING',
        resumeAvailable,
      });
    }

    if (isSupabaseConfigured() && !unrestricted) {
      const connectedIds = await fetchZohoConnectedApplywizzIdSet(
        candidateSummaries.map((c) => c.applywizzId)
      );
      candidateSummaries = candidateSummaries.filter((c) =>
        connectedIds.has(c.applywizzId.trim().toUpperCase())
      );
    }

    const aggregateScope = restrictedAccess
      ? {
          createdAtRange: restrictedAccess.createdAtRange,
          includeRow: (row: {
            assigned_ca_email?: string | null;
          }) =>
            applicationAssignedCaAllowedForRequest(
              row.assigned_ca_email,
              restrictedAccess!.userEmail || '',
              restrictedAccess!.role,
              restrictedAccess!.teamOperatorEmails,
              restrictedAccess!.viewAsManagerEmail
            ),
        }
      : undefined;
    const applicationAggregates = await fetchCandidateApplicationAggregatesByApplywizzIds(
      candidateSummaries.map((c) => c.applywizzId),
      aggregateScope
    );
    candidateSummaries = applyApplicationAggregatesToSummaries(
      candidateSummaries,
      applicationAggregates
    );

    if (unrestricted) {
      // Remove any prior or default-mapped instances of demo candidates to guarantee clean top placement
      const nonDemoSummaries = candidateSummaries.filter(
        (c) => c.applywizzId !== DEMO_APPLYWIZZ_ID && c.applywizzId !== AKSHITHA_APPLYWIZZ_ID
      );

      const demoSummary: CandidateSummary = {
        applywizzId: demoSegment.applywizzId,
        clientName: demoSegment.clientName,
        email: demoSegment.profile?.email || 'portgasdiscord@gmail.com',
        location: demoSegment.profile?.location || 'Hyderabad, Telangana, India',
        totalJobs: 0,
        job_count: 0,
        queue_status: 'NO_APPLICATIONS',
        readyCount: demoSegment.jobs.length,
        expiredCount: 0,
        status: 'READY',
        syncedAt: demoSegment.syncedAt,
        resumeAvailable: true,
      };

      const adminPinnedSummaries: CandidateSummary[] = [demoSummary];
      const generatedSegment = loadSecondaryDemoArtifacts().segment;
      if (generatedSegment) {
        adminPinnedSummaries.push({
          applywizzId: generatedSegment.applywizzId,
          clientName: generatedSegment.clientName,
          email: generatedSegment.profile?.email || '',
          location: generatedSegment.profile?.location || '',
          totalJobs: 0,
          job_count: 0,
          queue_status: 'NO_APPLICATIONS',
          readyCount: generatedSegment.jobs.length,
          expiredCount: 0,
          status: 'READY',
          syncedAt: generatedSegment.syncedAt,
          resumeAvailable: true,
        });
      }

      candidateSummaries = [...adminPinnedSummaries, ...nonDemoSummaries];
      const pinnedAggregates = await fetchCandidateApplicationAggregatesByApplywizzIds(
        adminPinnedSummaries.map((c) => c.applywizzId)
      );
      const enrichedPinned = applyApplicationAggregatesToSummaries(
        adminPinnedSummaries,
        pinnedAggregates
      );
      candidateSummaries = [...enrichedPinned, ...nonDemoSummaries];
    }

    // For unauthenticated / testing environments without headers, return flat array for backward-compatibility
    if (!userEmail && (process.env.NODE_ENV === 'test' || !req.headers.authorization)) {
      res.json(candidateSummaries);
      return;
    }

    log.info(
      `[API] GET /api/candidates role=${role ?? 'unknown'} unrestricted=${unrestricted} viewAs=${viewAsManagerEmail || '-'} allowedIds=${allowedIds?.size ?? 'all'} listed=${candidateSummaries.length} whRecords=${workHistoryRecords.length}`
    );

    if (!unrestricted && candidateSummaries.length === 0) {
      if (userEmail) {
        logActiveCandidatesThrottled(userEmail, 0);
      }
      res.json({
        candidates: [],
        message: `No candidates were assigned to you for ${parsedRange.label}.`,
        workHistoryUnreachable,
        dateRange: serializeDateRange(parsedRange),
      });
      return;
    }

    if (!unrestricted && userEmail) {
      logActiveCandidatesThrottled(userEmail, candidateSummaries.length);
    }

    res.json({
      candidates: candidateSummaries,
      workHistoryUnreachable,
      dateRange: serializeDateRange(parsedRange),
    });
  });

  /**
   * GET /api/candidates/:applywizzId
   * Returns candidate full profile, resume details, and assigned job queue (< MAX_JOB_QUESTIONS).
   */
  app.get('/api/candidates/:applywizzId', async (req: AuthenticatedRequest, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const access = await resolveDashboardCandidateAccess(req, parsedRange, res);
    const { unrestricted, workHistoryRecords } = access;

    if (access.authError) {
      log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
      res.status(401).json({ error: access.authError });
      return;
    }
    if (!isApplywizzIdInDashboardAccess(applywizzId, access)) {
      res.status(403).json({ error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.` });
      return;
    }

    const zohoGate = await assertApplywizzZohoConnected(applywizzId, {
      isAdmin: unrestricted,
      allowAdminDemo: true,
    });
    if (!zohoGate.allowed) {
      res.status(403).json({ error: zohoGate.error });
      return;
    }

    let seg = candidatesMap.get(applywizzId);
    if (!seg && mayServeInMemoryDemoFixtures(unrestricted)) {
      seg =
        applywizzId === DEMO_APPLYWIZZ_ID
          ? demoSegment
          : applywizzId === AKSHITHA_APPLYWIZZ_ID
            ? loadSecondaryDemoArtifacts().segment ?? undefined
            : undefined;
    }
    if (!mayServeInMemoryDemoFixtures(unrestricted) && isPinnedDemoApplywizzId(applywizzId)) {
      seg = undefined;
    }

    if (!seg) {
      const whRecord = workHistoryRecords.find(
        (r) => r.applywizzId.toUpperCase() === applywizzId.toUpperCase()
      );
      const profileFields = await fetchProfileListingFieldsByApplywizzIds([applywizzId]);
      const profileRow = profileFields.get(applywizzId.toUpperCase());

      const clientName = whRecord?.clientName || profileRow?.clientName || applywizzId;
      const clientEmail = whRecord?.clientEmail || profileRow?.email || '';

      if (whRecord || profileRow) {
        const resumeFilenameLocal = `${applywizzId}_resume.pdf`;
        const resumeExistsLocal = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilenameLocal));
        let resumeUrl: string | null = await getProfileResumeHttpUrl(applywizzId);
        let resumeFilename: string | null = resumeUrl ? path.basename(new URL(resumeUrl).pathname) : null;

        if (!resumeUrl && resumeExistsLocal) {
          resumeUrl = `/resumes/${resumeFilenameLocal}`;
          resumeFilename = resumeFilenameLocal;
        }

        res.json({
          applywizzId: whRecord?.applywizzId || profileRow?.applywizzId || applywizzId,
          clientName,
          profile: { email: clientEmail, location: profileRow?.location || '' },
          resumeUrl,
          resumeFilename,
          jobs: [],
        });
        return;
      }

      res.status(404).json({ error: `Candidate with Applywizz ID '${applywizzId}' not found.` });
      return;
    }

    const resumeFilenameLocal = `${applywizzId}_resume.pdf`;
    const resumeExistsLocal = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilenameLocal));
    let resumeUrl: string | null =
      (seg.profile?.resumeUrl && /^https?:\/\//i.test(seg.profile.resumeUrl)
        ? seg.profile.resumeUrl
        : null) || (await getProfileResumeHttpUrl(applywizzId));
    let resumeFilename: string | null = resumeUrl
      ? (() => {
          try {
            return path.basename(new URL(resumeUrl!).pathname);
          } catch {
            return `${applywizzId}_resume.pdf`;
          }
        })()
      : null;

    if (!resumeUrl && resumeExistsLocal) {
      resumeUrl = `/resumes/${resumeFilenameLocal}`;
      resumeFilename = resumeFilenameLocal;
    }

    const candidateApps = artifactCache.resolvedApplications.filter(
      (a) => a.applywizzId === applywizzId
    );

    const eligibleJobsWithStatus = seg.jobs
      .map((job) => {
        const canonical = job.canonicalUrl || job.rawUrl;
        const appItem =
          candidateApps.find(
            (a) =>
              a.jobUrl === canonical ||
              canonical.includes(a.jobUrl) ||
              a.jobUrl.includes(canonical)
          ) ||
          applicationsMap.get(`${applywizzId}::${canonical}`) ||
          applicationsMap.get(`${applywizzId}::${job.rawUrl}`);

        const template =
          templatesMap.get(canonical) ||
          templatesMap.get(job.rawUrl) ||
          Array.from(templatesMap.values()).find(
            (t) => t.jobUrl.includes(canonical) || canonical.includes(t.jobUrl)
          );

        const fieldsCount = appItem?.resolvedFields.length || template?.fields.length || 0;
        const hasManualEdits = Boolean(
          (appItem as any)?.has_manual_edits ||
          (appItem as any)?.hasManualEdits ||
          appItem?.resolvedFields?.some((f: any) => f.isEdited || f.source === 'manual')
        );

        return {
          ...job,
          canonicalUrl: appItem?.jobUrl || canonical,
          companyName: appItem?.companyName || template?.companyName || 'Greenhouse Company',
          jobTitle: appItem?.jobTitle || template?.jobTitle || 'Job Opening',
          status: appItem?.status || (template?.isExpired ? 'EXPIRED' : 'PENDING'),
          fieldsCount,
          hasManualEdits,
          eligibleForSubmission: computeEligibleForSubmissionDisplay({
            csv_job_score: parseCsvJobScore(job.score),
            field_count: fieldsCount,
          }),
        };
      });

    const dashboardJobs = eligibleJobsWithStatus;

    res.json({
      applywizzId: seg.applywizzId,
      clientName: seg.clientName,
      profile: seg.profile,
      resumeUrl,
      resumeFilename,
      jobs: dashboardJobs,
    });
  });

  /**
   * GET /api/candidates/:applywizzId/jobs
   * Returns only jobs belonging to the requested candidate, isolated to authenticated CA.
   */
  app.get('/api/candidates/:applywizzId/jobs', async (req: AuthenticatedRequest, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const access = await resolveDashboardCandidateAccess(req, parsedRange, res);
    const { unrestricted, userEmail, role, viewAsManagerEmail, teamOperatorEmails, createdAtRange } =
      access;

    if (access.authError) {
      log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
      res.status(401).json({ error: access.authError });
      return;
    }
    if (!isApplywizzIdInDashboardAccess(applywizzId, access)) {
      log.warn(
        `[API] GET /api/candidates/${applywizzId}/jobs (ca_email=${userEmail}) → filtered to 0 jobs (candidate not assigned to CA in work-history span)`
      );
      res.status(403).json({
        error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.`,
        applywizzId,
        jobs: [],
      });
      return;
    }

    const zohoGate = await assertApplywizzZohoConnected(applywizzId, {
      isAdmin: unrestricted,
      allowAdminDemo: true,
    });
    if (!zohoGate.allowed) {
      log.warn(
        `[API] GET /api/candidates/${applywizzId}/jobs (ca_email=${userEmail || 'admin'}) → Zoho gate blocked: ${zohoGate.error}`
      );
      res.status(403).json({ error: zohoGate.error, applywizzId, jobs: [] });
      return;
    }

    // Queue source: candidate_applications only (no SQL join to scanned_job_templates).
    // Template company/title enrichment is done in the dashboard via Supabase client on scanned_job_templates.
    let jobs: Array<Record<string, unknown>> = [];
    let dbRowCount = 0;
    let skippedCaAssignment = 0;
    let skippedUnresolved = 0;

    if (isSupabaseConfigured()) {
      let appQuery = getDbClient()
        .from('gh_candidate_applications')
        .select('*')
        .eq('applywizz_id', applywizzId);
      if (!unrestricted) {
        appQuery = applyCreatedAtRangeFilter(appQuery, createdAtRange);
      }
      const { data, error } = await appQuery;
      if (error) {
        log.error(`[API] Failed to fetch jobs for ${applywizzId}:`, error.message);
        res.status(500).json({ error: error.message });
        return;
      }
      dbRowCount = (data || []).length;
      for (const application of data || []) {
        if (
          !applicationAssignedCaAllowedForRequest(
            application.assigned_ca_email,
            userEmail || '',
            role,
            teamOperatorEmails,
            viewAsManagerEmail
          )
        ) {
          skippedCaAssignment++;
          continue;
        }
        if (!applicationRowHasPersistedResolution(application)) {
          skippedUnresolved++;
        }
        const jobStatus = String(application.status || 'PENDING').trim().toUpperCase();
        const fieldsCount = Array.isArray(application.resolved_fields)
          ? application.resolved_fields.length
          : 0;
        jobs.push({
          id: application.id,
          rawUrl: application.job_url,
          canonicalUrl: application.job_url,
          companyName: application.company_name || 'Greenhouse Company',
          jobTitle: application.job_title || 'Job Opening',
          status: jobStatus,
          error_message: application.error_message ?? null,
          fieldsCount,
          resolved_fields: Array.isArray(application.resolved_fields) ? application.resolved_fields : [],
          hasManualEdits: Boolean(application.has_manual_edits),
          eligibleForSubmission: computeEligibleForSubmissionDisplay({
            csv_job_score: application.csv_job_score,
            field_count: application.field_count ?? fieldsCount,
          }),
        });
      }
    }

    const afterCaFilter = jobs.length;
    const pinnedDemo = isPinnedDemoApplywizzId(applywizzId);
    if (mayServeInMemoryDemoFixtures(unrestricted)) {
      if (pinnedDemo) {
        jobs = mergeDashboardJobsByUrl(jobs, inMemoryDemoJobRowsForDashboard(applywizzId));
      } else if (jobs.length === 0) {
        jobs = mergeDashboardJobsByUrl(jobs, resolvedApplicationsToJobRows(applywizzId));
        if (jobs.length === 0) {
          jobs = mergeDashboardJobsByUrl(jobs, segmentToJobRows(resolvePinnedDemoSegment(applywizzId)));
        }
      }

    }

    log.info(
      `[API] GET /api/candidates/${applywizzId}/jobs (ca_email=${userEmail || 'admin'}) ` +
        `source=candidate_applications_only dbRows=${dbRowCount} skippedCaAssignment=${skippedCaAssignment} ` +
        `skippedUnresolved=${skippedUnresolved} afterCaFilter=${afterCaFilter} responseJobs=${jobs.length}`
    );
    res.json({ applywizzId, jobs });
  });

  /**
   * GET /api/candidates/:applywizzId/resume
   * Streams or serves candidate master resume PDF directly from Supabase Storage or local cache.
   */
  app.get('/api/candidates/:applywizzId/resume', async (req: AuthenticatedRequest, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const access = await resolveDashboardCandidateAccess(req, parsedRange, res);

    if (access.authError) {
      log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
      res.status(401).json({ error: access.authError });
      return;
    }
    if (!isApplywizzIdInDashboardAccess(applywizzId, access)) {
      res.status(403).json({ error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.` });
      return;
    }

    try {
      const buffer = await fetchResumePdfBuffer(applywizzId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${applywizzId}_resume.pdf"`);
      res.send(buffer);
      return;
    } catch {
      if (!isDemoResumeApplywizzId(applywizzId)) {
        res.status(404).json({ error: `Resume not found for candidate ${applywizzId}` });
        return;
      }
    }

    const localCandidates = [
      path.resolve(process.cwd(), config.RESUMES_DIR, `${applywizzId}_resume.pdf`),
      path.resolve(process.cwd(), config.RESUMES_DIR, 'AWL-YASHANTH_resume.pdf'),
      path.resolve(process.cwd(), config.RESUMES_DIR, 'my-resume.pdf'),
    ];
    for (const f of localCandidates) {
      if (fs.existsSync(f)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${applywizzId}_resume.pdf"`);
        res.sendFile(f);
        return;
      }
    }

    res.status(404).json({ error: `Resume not found for candidate ${applywizzId}` });
  });

  /**
   * GET /api/candidates/:applywizzId/jobs/*
   * Returns resolved CandidateJobApplication record for the specified candidate and job URL.
   */
  app.get('/api/candidates/:applywizzId/jobs/*', async (req: AuthenticatedRequest, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
    const parsedRange = parseDashboardCreatedAtRange(req.query as Record<string, unknown>);
    if ('error' in parsedRange) {
      res.status(400).json({ error: parsedRange.error });
      return;
    }
    const access = await resolveDashboardCandidateAccess(req, parsedRange, res);
    const { unrestricted, userEmail, role, viewAsManagerEmail, teamOperatorEmails } = access;

    if (access.authError) {
      log.error('[WorkHistory] ❌ CA email missing — cannot proceed');
      res.status(401).json({ error: access.authError });
      return;
    }
    if (!isApplywizzIdInDashboardAccess(applywizzId, access)) {
      res.status(403).json({ error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.` });
      return;
    }

    const zohoJobGate = await assertApplywizzZohoConnected(applywizzId, {
      isAdmin: unrestricted,
      allowAdminDemo: true,
    });
    if (!zohoJobGate.allowed) {
      res.status(403).json({ error: zohoJobGate.error });
      return;
    }

    // Extract everything after /jobs/ as raw URL
    const rawParam = req.params[0];
    const rawJobUrl =
      (Array.isArray(rawParam) ? rawParam[0] : rawParam) ||
      (typeof req.query.jobUrl === 'string' ? req.query.jobUrl : '') ||
      '';

    if (!rawJobUrl) {
      res.status(400).json({ error: 'Missing job URL parameter.' });
      return;
    }

    const decodedUrl = decodeURIComponent(rawJobUrl);

    // 0. FIRST check Supabase candidate_applications table as authoritative source of truth
    let supabaseRecord: any = null;
    if (isSupabaseConfigured()) {
      try {
        const supabase = getDbClient();
        const { data, error } = await supabase
          .from('gh_candidate_applications')
          .select('*')
          .eq('applywizz_id', applywizzId)
          .eq('job_url', decodedUrl)
          .maybeSingle();

        if (!error && data) {
          supabaseRecord = data;
        } else if (rawJobUrl !== decodedUrl) {
          const { data: altData } = await supabase
            .from('gh_candidate_applications')
            .select('*')
            .eq('applywizz_id', applywizzId)
            .eq('job_url', rawJobUrl)
            .maybeSingle();
          if (altData) supabaseRecord = altData;
        }
      } catch (err: any) {
        log.warn(`[Server] Error querying Supabase for candidate application ${applywizzId}:`, err.message);
      }
    }

    // 1. Check exact key match in applicationsMap
    let appItem =
      applicationsMap.get(`${applywizzId}::${decodedUrl}`) ||
      applicationsMap.get(`${applywizzId}::${rawJobUrl}`);

    // 2. Candidate applications match
    if (!appItem) {
      appItem = artifactCache.resolvedApplications.find(
        (a) =>
          a.applywizzId === applywizzId &&
          (a.jobUrl === decodedUrl ||
            a.jobUrl === rawJobUrl ||
            decodedUrl.includes(a.jobUrl) ||
            a.jobUrl.includes(decodedUrl))
      );
    }

    if (
      mayServeInMemoryDemoFixtures(unrestricted) &&
      !appItem &&
      (applywizzId === DEMO_APPLYWIZZ_ID || decodedUrl === DEMO_JOB_URL || rawJobUrl === DEMO_JOB_URL)
    ) {
      appItem = demoApplication;
    }

    if (mayServeInMemoryDemoFixtures(unrestricted) && !appItem && applywizzId === AKSHITHA_APPLYWIZZ_ID) {
      appItem = loadSecondaryDemoArtifacts().applications.find(
        (a) =>
          a.jobUrl === decodedUrl ||
          a.jobUrl === rawJobUrl ||
          decodedUrl.includes(a.jobUrl) ||
          a.jobUrl.includes(decodedUrl)
      );
    }

    if (
      appItem &&
      !mayServeInMemoryDemoFixtures(unrestricted) &&
      isDashboardDemoFixtureJob(applywizzId, { canonicalUrl: appItem.jobUrl, rawUrl: appItem.jobUrl })
    ) {
      appItem = undefined;
    }

    let lookupUrl = decodedUrl;
    if (!appItem && decodedUrl.includes('grnh.se')) {
      try {
        lookupUrl = await resolveShortlink(decodedUrl);
        appItem =
          applicationsMap.get(`${applywizzId}::${lookupUrl}`) ||
          artifactCache.resolvedApplications.find(
            (a) =>
              a.applywizzId === applywizzId &&
              (a.jobUrl === lookupUrl ||
                lookupUrl.includes(a.jobUrl) ||
                a.jobUrl.includes(lookupUrl))
          );
      } catch {}
    }

    // If Supabase record exists, return it immediately as source of truth
    if (supabaseRecord) {
      if (
        !unrestricted &&
        !applicationAssignedCaAllowedForRequest(
          supabaseRecord.assigned_ca_email,
          userEmail || '',
          role,
          teamOperatorEmails,
          viewAsManagerEmail
        )
      ) {
        res.status(403).json({ error: `Access denied: Application is not assigned to your team.` });
        return;
      }
      if (
        !applicationRowHasPersistedResolution(supabaseRecord) &&
        !isPinnedDemoApplywizzId(applywizzId)
      ) {
        res.status(404).json({
          error: `Application not yet resolved for candidate '${applywizzId}' and job '${decodedUrl}'.`,
        });
        return;
      }
      let row = supabaseRecord as ApplicationRow;
      row = await hydrateAndPersistApplicationFields(row);
      row = await hydrateApplicationProofUrls(row);

      const resolvedFields = row.resolved_fields?.length
        ? row.resolved_fields
        : appItem?.resolvedFields || [];
      const status = row.status;
      const companyName = row.company_name || appItem?.companyName || '';
      const jobTitle = row.job_title || appItem?.jobTitle || '';
      const candidateName = (appItem as any)?.candidateName || '';

      cacheApplicationLocally({
        ...row,
        company_name: companyName,
        job_title: jobTitle,
      });

      res.json(
        serializeApplicationDto(row, {
          applywizz_id: applywizzId,
          job_url: row.job_url || decodedUrl,
          company_name: companyName,
          job_title: jobTitle,
          candidate_name: candidateName,
          status,
          resolved_fields: resolvedFields,
        })
      );
      return;
    }

    if (appItem) {
      const rowId = (appItem as any).id || `${appItem.applywizzId}_${Buffer.from(appItem.jobUrl).toString('base64url').slice(0, 16)}`;
      let resolvedFields = appItem.resolvedFields;
      let status = appItem.status;
      let proofWebUrl = (appItem as any).proofWebUrl || (appItem as any).proof_web_url;
      let dryRunScreenshotUrl = (appItem as any).dryRunScreenshotUrl || (appItem as any).dry_run_screenshot_url;
      let hasManualEdits = (appItem as any).hasManualEdits || (appItem as any).has_manual_edits;

      try {
        const memApp = (await getApplication(rowId, appItem.jobUrl)) || (await getApplication(appItem.applywizzId, appItem.jobUrl));
        if (memApp) {
          if (Array.isArray(memApp.resolved_fields) && memApp.resolved_fields.length > 0) {
            resolvedFields = memApp.resolved_fields as any;
          }
          if (memApp.status) status = memApp.status as any;
          if (memApp.proof_web_url) proofWebUrl = memApp.proof_web_url;
          if (memApp.dry_run_screenshot_url) dryRunScreenshotUrl = memApp.dry_run_screenshot_url;
          if (memApp.has_manual_edits !== undefined) hasManualEdits = memApp.has_manual_edits;
        }
      } catch {}

      // Persist to Supabase if not yet present so it exists for next navigation
      let persistedRow: any = null;
      try {
        persistedRow = await upsertApplication({
          applywizz_id: appItem.applywizzId,
          job_url: appItem.jobUrl,
          company_name: appItem.companyName,
          job_title: appItem.jobTitle,
          status: status as any || 'READY_FOR_REVIEW',
          resolved_fields: resolvedFields,
          proof_web_url: proofWebUrl,
          dry_run_screenshot_url: dryRunScreenshotUrl,
          has_manual_edits: hasManualEdits,
        });
      } catch {}

      const finalId = persistedRow?.id || rowId;

      cacheApplicationLocally({
        ...toApplicationRow(appItem),
        id: finalId,
        resolved_fields: resolvedFields,
        status: status as any,
        proof_web_url: proofWebUrl,
        dry_run_screenshot_url: dryRunScreenshotUrl,
        has_manual_edits: hasManualEdits,
      });

      res.json(
        serializeApplicationDto(
          { ...appItem, ...(persistedRow || {}) },
          {
            id: finalId,
            applywizz_id: applywizzId,
            job_url: appItem.jobUrl,
            status,
            resolved_fields: resolvedFields,
            proof_web_url: proofWebUrl,
            dry_run_screenshot_url: dryRunScreenshotUrl,
            has_manual_edits: hasManualEdits,
          }
        )
      );
      return;
    }

    // 3. Fallback: construct application payload from template if available
    const template =
      templatesMap.get(decodedUrl) ||
      templatesMap.get(lookupUrl) ||
      Array.from(templatesMap.values()).find(
        (t) => t.jobUrl.includes(decodedUrl) || decodedUrl.includes(t.jobUrl)
      );

    const seg = candidatesMap.get(applywizzId);

    if (template && seg) {
      res.json({
        applywizzId,
        candidateName: seg.clientName,
        jobUrl: template.jobUrl,
        companyName: template.companyName,
        jobTitle: template.jobTitle,
        status: template.isExpired ? 'EXPIRED' : 'PENDING',
        resolvedFields: template.fields.map((f) => ({
          fieldId: f.fieldId,
          name: f.name,
          type: f.type,
          label: f.label,
          value: '',
          source: 'supabase',
          confidence: 0,
        })),
      });
      return;
    }

    res.status(404).json({
      error: `Application not found for candidate '${applywizzId}' and job '${decodedUrl}'.`,
    });
  });

  /**
   * Catch-all route serving the dashboard SPA index.html.
   */
  app.get('*', requireRoleIfAuthenticated('operator', 'dev'), (_req: Request, res: Response) => {
    const indexPath = path.resolve(process.cwd(), 'dashboard/public/index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
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
      if (config.ZOHO_CONNECTOR_USER && config.ZOHO_CONNECTOR_PASS) {
        zohoReader.init().catch((err: any) => {
          log.warn(`[Server] ⚠️ Zoho Reader background initialization error: ${err.message}`);
        });
      }
    } else {
      createLogger('ZohoReader').info(
        '[ZohoReader] Skipping background session — queue worker disabled on this service'
      );
    }

    // Launch background round-robin submission worker daemon if enabled (Phase V2-4c)
    let queueDaemon: SubmissionQueueDaemon | null = null;
    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      const concurrency = process.env.WORKER_CONCURRENCY ? parseInt(process.env.WORKER_CONCURRENCY, 10) : 2;
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
    await zohoReader.cleanup().catch(() => {});
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
