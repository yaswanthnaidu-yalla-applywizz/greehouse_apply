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

import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { resolveShortlink } from '../scanner/csvDeduplicator.js';
import { applicationsRouter } from './routes/applications.js';
import { submissionsRouter } from './routes/submissions.js';
import { authRouter, isUserAdmin } from './routes/auth.js';
import { notificationsRouter } from './routes/notifications.js';
import { configRouter } from './routes/config.js';
import { managerRouter } from './routes/manager.js';
import { wsManager } from './ws.js';
import { requireAuth, type AuthenticatedRequest } from './middleware/auth.js';
import { getCachedWorkHistory, setCachedWorkHistory } from './workHistoryCache.js';
import { getAuthenticatedCaEmail } from './workHistoryAuth.js';
import {
  fetchAllowedCandidates,
  fetchWorkHistoryForDate,
  fetchAdminWorkHistoryForDate,
  ADMIN_WORK_HISTORY_CACHE_KEY,
  getYesterdayIST,
  type WorkHistoryCandidateRecord,
} from '../services/workHistoryClient.js';
import { hydrateAdminProfilesFromWorkHistory } from '../services/adminProfileHydrate.js';
import { cacheApplicationLocally, getSubmissionOutcomeCounts, getApplication, upsertApplication, serializeApplicationDto } from '../db/applications.js';
import { fetchResumePdfBuffer, getProfileResumeHttpUrl, isDemoResumeApplywizzId } from '../db/storage.js';
import { isSupabaseConfigured, getDbClient, logSupabaseCredentialIdentity, resolveSupabaseCredentials } from '../db/client.js';
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
} from '../dashboard/demoFixtures.js';
import { zohoReader } from '../services/zohoReader.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedJobTemplate,
} from '../types/index.js';

const ACTIVE_CANDIDATES_LOG_INTERVAL_MS = 10 * 60 * 1000;
const lastActiveCandidatesLogByCa = new Map<string, number>();

function logActiveCandidatesThrottled(caEmail: string, count: number): void {
  const key = caEmail.trim().toLowerCase();
  if (!key) return;
  const now = Date.now();
  const last = lastActiveCandidatesLogByCa.get(key) ?? 0;
  if (now - last < ACTIVE_CANDIDATES_LOG_INTERVAL_MS) return;
  lastActiveCandidatesLogByCa.set(key, now);
  console.log(`[Dashboard] Active candidates: ${count} assigned to ${key}`);
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
  readyCount: number;
  expiredCount: number;
  status: 'READY' | 'PENDING' | 'EXPIRED';
  syncedAt?: string;
  resumeAvailable: boolean;
}

/**
 * Global metrics and pipeline status.
 */
export interface DashboardStats {
  totalCandidates: number;
  totalApplications: number;
  successfulApplications: number;
  failedApplications: number;
  uniqueScannedJobs: number;
  totalFieldsPopulated: number;
  supabaseTaggedCount: number;
  aiTaggedCount: number;
  supabasePercentage: number;
  aiPercentage: number;
  pipelineStatus: 'READY' | 'IDLE' | 'PROCESSING';
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

/** Parse CSV/job score for dashboard eligibility (20–60). */
function parseDashboardJobScore(score: string | number | undefined): number {
  if (score === undefined || score === null) return 0;
  if (typeof score === 'number') return Number.isFinite(score) ? score : 0;
  const parsed = parseFloat(String(score).trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDashboardJobScoreInRange(job: { score?: string | number }): boolean {
  const score = parseDashboardJobScore(job.score);
  return score >= 20 && score <= 60;
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

function isDashboardJobScoreEligible(
  applywizzId: string,
  job: { score?: string | number; canonicalUrl?: string; rawUrl?: string },
  isAdmin: boolean
): boolean {
  if (isAdmin && isDashboardDemoFixtureJob(applywizzId, job)) {
    return true;
  }
  if (isPinnedDemoApplywizzId(applywizzId) && isDashboardDemoFixtureJob(applywizzId, job)) {
    return true;
  }
  return isDashboardJobScoreInRange(job);
}

function isPinnedDemoApplywizzId(applywizzId: string): boolean {
  const id = applywizzId.trim().toUpperCase();
  return id === DEMO_APPLYWIZZ_ID.toUpperCase() || id === AKSHITHA_APPLYWIZZ_ID.toUpperCase();
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
      console.warn(`[Server] ⚠️ Failed to read ${segmentsPath}: ${err.message}`);
    }
  }

  if (fs.existsSync(templatesPath)) {
    try {
      templates = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'));
    } catch (err: any) {
      console.warn(`[Server] ⚠️ Failed to read ${templatesPath}: ${err.message}`);
    }
  }

  if (fs.existsSync(applicationsPath)) {
    try {
      applications = JSON.parse(fs.readFileSync(applicationsPath, 'utf-8'));
    } catch (err: any) {
      console.warn(`[Server] ⚠️ Failed to read ${applicationsPath}: ${err.message}`);
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
    console.log(
      `[Server] ✅ Artifacts loaded: ${artifactCache.candidateSegments.length} candidates, ${artifactCache.scannedJobs.length} templates, ${artifactCache.resolvedApplications.length} applications`
    );
  }
}

/** Outcome of the most recent operator-triggered storage CSV ingestion. */
interface IngestRunState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  processedCount?: number;
  processedFile?: string;
  message?: string;
  error?: string;
}

/**
 * Creates and configures the Express application instance.
 *
 * @returns Configured Express application.
 */
export function createServer(outputDir: string = config.OUTPUT_DIR): express.Application {
  loadArtifacts(outputDir, { log: true });
  const app = express();

  // State of the operator-triggered storage CSV ingestion run (one at a time).
  let ingestRun: IngestRunState = { running: false };

  app.use(cors());
  app.use(express.json());

  // Static directory for master resume PDFs
  const resumesDir = path.resolve(process.cwd(), config.RESUMES_DIR);
  if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
  }
  app.use('/resumes', express.static(resumesDir));

  // Static directory for dashboard web assets
  const publicDir = path.resolve(process.cwd(), 'dashboard/public');
  const managerHtmlPath = path.join(publicDir, 'manager.html');
  app.get('/manager', (_req: Request, res: Response) => {
    if (fs.existsSync(managerHtmlPath)) {
      res.sendFile(managerHtmlPath);
      return;
    }
    res.status(404).send('Manager dashboard page not found.');
  });
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Auth routes (public)
  app.use('/api/auth', authRouter);

  // Applications, field patch, dry-run, and submission routes (protected)
  app.use('/api/applications', requireAuth, submissionsRouter);
  app.use('/api/applications', requireAuth, applicationsRouter);

  // Real events notifications routes (protected)
  app.use('/api/notifications', requireAuth, notificationsRouter);

  // Dashboard client config (protected)
  app.use('/api/config', requireAuth, configRouter);

  // Manager dashboard routes (admin-only within the router)
  app.use('/api/manager', requireAuth, managerRouter);

  // Protect candidates and admin namespaces
  app.use('/api/candidates', requireAuth);
  app.use('/api/admin', requireAuth);

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
  app.get('/api/stats', async (req: Request, res: Response) => {
    let totalFields = 0;
    let supabaseCount = 0;
    let aiCount = 0;

    for (const appItem of artifactCache.resolvedApplications) {
      for (const f of appItem.resolvedFields) {
        totalFields++;
        if (f.source === 'supabase') supabaseCount++;
        if (f.source === 'ai') aiCount++;
      }
    }

    const dateParam = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : undefined;

    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin((req as any).user || userEmail);

    let allowedCandidateIds: string[] | undefined = undefined;
    if (!isAdmin) {
      const targetDate = dateParam || getYesterdayIST();
      if (!userEmail) {
        console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
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

    const outcomes = await getSubmissionOutcomeCounts({
      date: dateParam,
      allowedCandidateIds,
    });

    const stats: DashboardStats = {
      totalCandidates: artifactCache.candidateSegments.length,
      totalApplications: artifactCache.resolvedApplications.length,
      successfulApplications: outcomes.successfulApplications,
      failedApplications: outcomes.failedApplications,
      uniqueScannedJobs: artifactCache.scannedJobs.length,
      totalFieldsPopulated: totalFields,
      supabaseTaggedCount: supabaseCount,
      aiTaggedCount: aiCount,
      supabasePercentage: totalFields ? Number(((supabaseCount / totalFields) * 100).toFixed(1)) : 0,
      aiPercentage: totalFields ? Number(((aiCount / totalFields) * 100).toFixed(1)) : 0,
      pipelineStatus: artifactCache.resolvedApplications.length > 0 ? 'READY' : 'IDLE',
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
   * POST /api/admin/trigger-ingest-from-storage
   * Ingests newly uploaded CSV files from the Supabase Storage dropzone.
   *
   * The pipeline takes minutes, so the run happens in the background and the caller
   * polls GET /api/admin/ingest-status for the outcome.
   */
  app.post('/api/admin/trigger-ingest-from-storage', async (req: AuthenticatedRequest, res: Response) => {
    if (!isUserAdmin(req.user || getAuthenticatedCaEmail(req))) {
      res.status(403).json({ error: 'Forbidden: only admins can start the pipeline.' });
      return;
    }

    if (ingestRun.running) {
      res.status(409).json({
        error: 'Ingestion is already running.',
        ...ingestRun,
      });
      return;
    }

    const startedAt = new Date().toISOString();
    ingestRun = { running: true, startedAt };
    console.log(`[Admin] ▶️ Storage CSV ingestion started at ${startedAt}`);
    res.status(202).json({ started: true, startedAt });

    try {
      const { ingestCsvFromStorage } = await import('../scanner/storageCsvIngestion.js');
      const result = await ingestCsvFromStorage();
      if (result.processedCount > 0) {
        loadArtifacts(outputDir);
      }
      ingestRun = {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        processedCount: result.processedCount,
        processedFile: result.processedFile,
        // A failed run reports through `message`; surface it as an error so the
        // dashboard does not show a misconfiguration as a calm "nothing to do".
        message: result.success ? result.message : undefined,
        error: result.success ? undefined : result.message,
      };
      console.log(
        `[Admin] ${result.success ? '✅' : '❌'} Storage CSV ingestion finished: ${result.message}`
      );
    } catch (err: any) {
      const message = err.message || 'Storage ingestion failed';
      ingestRun = {
        running: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: message,
      };
      console.error('[Admin] ❌ Storage CSV ingestion failed:', err);
    }
  });

  /**
   * GET /api/admin/ingest-status
   * Reports the state of the most recent storage CSV ingestion run.
   */
  app.get('/api/admin/ingest-status', (req: AuthenticatedRequest, res: Response) => {
    if (!isUserAdmin(req.user || getAuthenticatedCaEmail(req))) {
      res.status(403).json({ error: 'Forbidden: only admins can view ingestion status.' });
      return;
    }
    res.json(ingestRun);
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
    const supabase = getDbClient();
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
    const bucketNames = (buckets || []).map((b) => b.name);
    const { data: listed, error: csvProbeError } = await supabase.storage
      .from(CSV_UPLOADS_BUCKET)
      .list('', { limit: 100, offset: 0 });
    res.json({
      configured: true,
      serviceKeySource,
      diagnostics: diagnostics.summary,
      jwtRole: diagnostics.jwtRole,
      urlRefMatch: diagnostics.urlRefMatch,
      listBucketsError: bucketsError?.message ?? null,
      visibleBuckets: bucketNames,
      csvUploadsDirectListOk: !csvProbeError,
      csvUploadsDirectListError: csvProbeError?.message ?? null,
      csvUploadsListNames: (listed || []).map((f) => f.name),
    });
  });

  /**
   * GET /api/candidates
   * Returns summary list of all segregated candidates with job counts and status for the selected IST date.
   */
  app.get('/api/candidates', async (req: AuthenticatedRequest, res: Response) => {
    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin(req.user || userEmail);

    const dateParam = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : getYesterdayIST();

    let allowedIds: Set<string> | null = null;
    let workHistoryRecords: WorkHistoryCandidateRecord[] = [];
    let workHistoryUnreachable = false;

    if (isAdmin) {
      let cached = getCachedWorkHistory(ADMIN_WORK_HISTORY_CACHE_KEY, dateParam);
      if (!cached) {
        const whResult = await fetchAdminWorkHistoryForDate(dateParam);
        try {
          await hydrateAdminProfilesFromWorkHistory(dateParam);
        } catch (hydrateErr: any) {
          console.warn('[Server] Admin profile hydration on candidates list failed:', hydrateErr?.message);
        }
        setCachedWorkHistory(
          ADMIN_WORK_HISTORY_CACHE_KEY,
          whResult.records,
          whResult.candidateIds,
          whResult.unreachable,
          whResult.resolvedDate,
          dateParam
        );
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      workHistoryUnreachable = cached.unreachable;
      workHistoryRecords = cached.records;
    } else if (userEmail) {
      let cached = getCachedWorkHistory(userEmail, dateParam);
      if (!cached) {
        const whResult = await fetchWorkHistoryForDate(userEmail, dateParam);
        setCachedWorkHistory(userEmail, whResult.records, whResult.candidateIds, whResult.unreachable, whResult.resolvedDate, dateParam);
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      workHistoryUnreachable = cached.unreachable;
      workHistoryRecords = cached.records;
      allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));
    } else {
      console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
      res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
      return;
    }

    res.setHeader('X-Work-History-Unreachable', String(workHistoryUnreachable));
    res.setHeader('X-Work-History-Date', dateParam);

    // 1. Process candidateSegments
    const matchedSegments = artifactCache.candidateSegments.filter(
      (seg) => !allowedIds || allowedIds.has(seg.applywizzId.toUpperCase())
    );

    let candidateSummaries: CandidateSummary[] = matchedSegments.map((seg) => {
      const candidateApps = artifactCache.resolvedApplications.filter(
        (a) => a.applywizzId === seg.applywizzId
      );
      const readyCount = candidateApps.filter((a) => a.status === 'READY_FOR_REVIEW').length;
      const expiredCount = candidateApps.filter((a) => a.status === 'EXPIRED').length;

      // Filter to only jobs eligible under current question threshold (< MAX_JOB_QUESTIONS)
      const eligibleJobs = seg.jobs.filter((job) => {
        if (!isDashboardJobScoreEligible(seg.applywizzId, job, isAdmin)) {
          return false;
        }
        if (
          seg.applywizzId === DEMO_APPLYWIZZ_ID ||
          seg.applywizzId === AKSHITHA_APPLYWIZZ_ID ||
          job.canonicalUrl === DEMO_JOB_URL ||
          job.rawUrl === DEMO_JOB_URL
        ) {
          return true;
        }
        const canonical = job.canonicalUrl || job.rawUrl;
        const template =
          templatesMap.get(canonical) ||
          templatesMap.get(job.rawUrl) ||
          Array.from(templatesMap.values()).find(
            (t) => t.jobUrl.includes(canonical) || canonical.includes(t.jobUrl)
          );
        if (template && template.fields && template.fields.length >= config.MAX_JOB_QUESTIONS) {
          return false;
        }
        return true;
      });

      const resumePath = path.join(config.RESUMES_DIR, `${seg.applywizzId}_resume.pdf`);
      const resumeAvailable = fs.existsSync(resumePath);

      let status: 'READY' | 'PENDING' | 'EXPIRED' = 'PENDING';
      if (readyCount > 0) {
        status = 'READY';
      } else if (expiredCount === eligibleJobs.length && eligibleJobs.length > 0) {
        status = 'EXPIRED';
      }

      return {
        applywizzId: seg.applywizzId,
        clientName: seg.clientName,
        email: seg.profile?.email || '',
        location: seg.profile?.location || '',
        totalJobs: eligibleJobs.length,
        readyCount,
        expiredCount,
        status,
        syncedAt: seg.syncedAt,
        resumeAvailable,
      };
    });

    // 2. Synthesize candidates from workHistoryRecords that are not yet in candidateSegments
    if (workHistoryRecords.length > 0) {
      const existingIds = new Set(candidateSummaries.map((c) => c.applywizzId.toUpperCase()));
      for (const rec of workHistoryRecords) {
        const idUpper = rec.applywizzId.toUpperCase();
        if (!existingIds.has(idUpper)) {
          const resumePath = path.join(config.RESUMES_DIR, `${rec.applywizzId}_resume.pdf`);
          candidateSummaries.push({
            applywizzId: rec.applywizzId,
            clientName: rec.clientName,
            email: rec.clientEmail,
            location: '',
            totalJobs: 0,
            readyCount: 0,
            expiredCount: 0,
            status: 'PENDING',
            resumeAvailable: fs.existsSync(resumePath),
          });
          existingIds.add(idUpper);
        }
      }
    }

    if (isSupabaseConfigured()) {
      const connectedIds = await fetchZohoConnectedApplywizzIdSet(
        candidateSummaries.map((c) => c.applywizzId)
      );
      candidateSummaries = candidateSummaries.filter((c) =>
        connectedIds.has(c.applywizzId.trim().toUpperCase())
      );
    }

    if (isAdmin) {
      // Remove any prior or default-mapped instances of demo candidates to guarantee clean top placement
      const nonDemoSummaries = candidateSummaries.filter(
        (c) => c.applywizzId !== DEMO_APPLYWIZZ_ID && c.applywizzId !== AKSHITHA_APPLYWIZZ_ID
      );

      const demoSummary: CandidateSummary = {
        applywizzId: demoSegment.applywizzId,
        clientName: demoSegment.clientName,
        email: demoSegment.profile?.email || 'portgasdiscord@gmail.com',
        location: demoSegment.profile?.location || 'Hyderabad, Telangana, India',
        totalJobs: demoSegment.jobs.length,
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
          totalJobs: generatedSegment.jobs.length,
          readyCount: generatedSegment.jobs.length,
          expiredCount: 0,
          status: 'READY',
          syncedAt: generatedSegment.syncedAt,
          resumeAvailable: true,
        });
      }

      candidateSummaries = [...adminPinnedSummaries, ...nonDemoSummaries];
    }

    // For unauthenticated / testing environments without headers, return flat array for backward-compatibility
    if (!userEmail && (process.env.NODE_ENV === 'test' || !req.headers.authorization)) {
      res.json(candidateSummaries);
      return;
    }

    if (!isAdmin && candidateSummaries.length === 0) {
      if (userEmail) {
        logActiveCandidatesThrottled(userEmail, 0);
      }
      res.json({
        candidates: [],
        message: `No candidates were assigned to you on ${dateParam}.`,
        workHistoryUnreachable,
        selectedDate: dateParam,
      });
      return;
    }

    if (!isAdmin && userEmail) {
      logActiveCandidatesThrottled(userEmail, candidateSummaries.length);
    }

    res.json({
      candidates: candidateSummaries,
      workHistoryUnreachable,
      selectedDate: dateParam,
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
    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin(req.user || userEmail);
    let caWorkHistoryEmail: string | undefined;

    if (!isAdmin) {
      if (!userEmail) {
        console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
      caWorkHistoryEmail = userEmail;
      let cached = getCachedWorkHistory(caWorkHistoryEmail);
      if (!cached) {
        const whResult = await fetchAllowedCandidates(caWorkHistoryEmail);
        setCachedWorkHistory(caWorkHistoryEmail, whResult.records, whResult.candidateIds, whResult.unreachable, whResult.resolvedDate);
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      const allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));
      if (!allowedIds.has(applywizzId.toUpperCase())) {
        res.status(403).json({ error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.` });
        return;
      }
    }

    const zohoGate = await assertApplywizzZohoConnected(applywizzId, {
      isAdmin,
      allowAdminDemo: true,
    });
    if (!zohoGate.allowed) {
      res.status(403).json({ error: zohoGate.error });
      return;
    }

    const seg =
      candidatesMap.get(applywizzId) ||
      (applywizzId === DEMO_APPLYWIZZ_ID
        ? demoSegment
        : applywizzId === AKSHITHA_APPLYWIZZ_ID
        ? loadSecondaryDemoArtifacts().segment ?? undefined
        : undefined);

    if (!seg) {
      // Check if it's a synthesized candidate from work-history
      let whRecord: WorkHistoryCandidateRecord | undefined;
      if (caWorkHistoryEmail) {
        const cached = getCachedWorkHistory(caWorkHistoryEmail);
        whRecord = cached?.records.find((r) => r.applywizzId.toUpperCase() === applywizzId.toUpperCase());
      }
      if (whRecord) {
        const resumeFilenameLocal = `${applywizzId}_resume.pdf`;
        const resumeExistsLocal = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilenameLocal));
        let resumeUrl: string | null = await getProfileResumeHttpUrl(applywizzId);
        let resumeFilename: string | null = resumeUrl ? path.basename(new URL(resumeUrl).pathname) : null;

        if (!resumeUrl && resumeExistsLocal) {
          resumeUrl = `/resumes/${resumeFilenameLocal}`;
          resumeFilename = resumeFilenameLocal;
        }

        res.json({
          applywizzId: whRecord.applywizzId,
          clientName: whRecord.clientName,
          profile: { email: whRecord.clientEmail },
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

    // Enrich jobs with resolved application status and metadata, filtering to < MAX_JOB_QUESTIONS
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
        };
      })
      .filter(
        (job) =>
          seg.applywizzId === DEMO_APPLYWIZZ_ID ||
          seg.applywizzId === AKSHITHA_APPLYWIZZ_ID ||
          job.canonicalUrl === DEMO_JOB_URL ||
          job.fieldsCount < config.MAX_JOB_QUESTIONS
      );

    const totalBeforeScoreFilter = eligibleJobsWithStatus.length;
    const dashboardJobs = eligibleJobsWithStatus.filter((job) =>
      isDashboardJobScoreEligible(seg.applywizzId, job, isAdmin)
    );
    console.log(
      `[Dashboard] Filtered jobs: showed ${dashboardJobs.length}/${totalBeforeScoreFilter} (score 20–60 only).`
    );

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
    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin(req.user || userEmail);
    const targetDate =
      typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : getYesterdayIST();

    if (!isAdmin) {
      if (!userEmail) {
        console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }

      let cached = getCachedWorkHistory(userEmail, targetDate) || getCachedWorkHistory(userEmail);
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

      if (cached.candidateIds.length === 0 && !req.query.date) {
        const allowedResult = await fetchAllowedCandidates(userEmail);
        if (allowedResult.candidateIds.length > 0) {
          setCachedWorkHistory(userEmail, allowedResult.records, allowedResult.candidateIds, allowedResult.unreachable, allowedResult.resolvedDate);
          cached = {
            records: allowedResult.records,
            candidateIds: allowedResult.candidateIds,
            expiresAt: Date.now() + 5 * 60 * 1000,
            unreachable: allowedResult.unreachable,
            resolvedDate: allowedResult.resolvedDate,
          };
        }
      }

      const allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));
      if (!allowedIds.has(applywizzId.toUpperCase())) {
        console.warn(
          `[API] GET /api/candidates/${applywizzId}/jobs (ca_email=${userEmail}) → filtered to 0 jobs (candidate not assigned to CA on ${targetDate})`
        );
        res.status(403).json({
          error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.`,
          applywizzId,
          jobs: [],
        });
        return;
      }
    }

    const zohoGate = await assertApplywizzZohoConnected(applywizzId, {
      isAdmin,
      allowAdminDemo: true,
    });
    if (!zohoGate.allowed) {
      console.warn(
        `[API] GET /api/candidates/${applywizzId}/jobs (ca_email=${userEmail || 'admin'}) → Zoho gate blocked: ${zohoGate.error}`
      );
      res.status(403).json({ error: zohoGate.error, applywizzId, jobs: [] });
      return;
    }

    let jobs: Array<Record<string, unknown>> = [];

    if (isSupabaseConfigured()) {
      const { data, error } = await getDbClient()
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', applywizzId);
      if (error) {
        console.error(`[API] Failed to fetch jobs for ${applywizzId}:`, error.message);
        res.status(500).json({ error: error.message });
        return;
      }
      for (const application of data || []) {
        if (!isAdmin && userEmail && application.assigned_ca_email &&
            application.assigned_ca_email.trim().toLowerCase() !== userEmail.trim().toLowerCase()) {
          continue;
        }
        jobs.push({
          rawUrl: application.job_url,
          canonicalUrl: application.job_url,
          companyName: application.company_name || 'Greenhouse Company',
          jobTitle: application.job_title || 'Job Opening',
          status: application.status || 'PENDING',
          fieldsCount: Array.isArray(application.resolved_fields) ? application.resolved_fields.length : 0,
          hasManualEdits: Boolean(application.has_manual_edits),
        });
      }
    }

    const pinnedDemo = isPinnedDemoApplywizzId(applywizzId);
    if (pinnedDemo && isAdmin) {
      jobs = mergeDashboardJobsByUrl(jobs, resolvedApplicationsToJobRows(applywizzId));
      jobs = mergeDashboardJobsByUrl(jobs, segmentToJobRows(resolvePinnedDemoSegment(applywizzId)));
    } else if (jobs.length === 0) {
      jobs = mergeDashboardJobsByUrl(jobs, resolvedApplicationsToJobRows(applywizzId));
      if (jobs.length === 0) {
        jobs = mergeDashboardJobsByUrl(jobs, segmentToJobRows(resolvePinnedDemoSegment(applywizzId)));
      }
    }

    if (pinnedDemo) {
      jobs = jobs.filter((job) =>
        isDashboardJobScoreEligible(applywizzId, job as { score?: string | number; canonicalUrl?: string; rawUrl?: string }, isAdmin)
      );
    }

    console.log(
      `[API] GET /api/candidates/${applywizzId}/jobs (ca_email=${userEmail || 'admin'}) → filtered to ${jobs.length} jobs`
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
    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin(req.user || userEmail);

    if (!isAdmin) {
      if (!userEmail) {
        console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
      let cached = getCachedWorkHistory(userEmail) || getCachedWorkHistory(userEmail, getYesterdayIST());
      if (!cached) {
        const whResult = await fetchAllowedCandidates(userEmail);
        setCachedWorkHistory(userEmail, whResult.records, whResult.candidateIds, whResult.unreachable, whResult.resolvedDate);
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      const allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));
      if (!allowedIds.has(applywizzId.toUpperCase())) {
        res.status(403).json({ error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.` });
        return;
      }
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
    const userEmail = getAuthenticatedCaEmail(req);
    const isAdmin = isUserAdmin(req.user || userEmail);

    if (!isAdmin) {
      if (!userEmail) {
        console.error('[WorkHistory] ❌ CA email missing — cannot proceed');
        res.status(401).json({ error: 'Unauthorized: CA email missing — cannot proceed' });
        return;
      }
      let cached = getCachedWorkHistory(userEmail);
      if (!cached) {
        const whResult = await fetchAllowedCandidates(userEmail);
        setCachedWorkHistory(userEmail, whResult.records, whResult.candidateIds, whResult.unreachable, whResult.resolvedDate);
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      const allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));
      if (!allowedIds.has(applywizzId.toUpperCase())) {
        res.status(403).json({ error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.` });
        return;
      }
    }

    const zohoJobGate = await assertApplywizzZohoConnected(applywizzId, {
      isAdmin,
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
          .from('candidate_applications')
          .select('*')
          .eq('applywizz_id', applywizzId)
          .eq('job_url', decodedUrl)
          .maybeSingle();

        if (!error && data) {
          supabaseRecord = data;
        } else if (rawJobUrl !== decodedUrl) {
          const { data: altData } = await supabase
            .from('candidate_applications')
            .select('*')
            .eq('applywizz_id', applywizzId)
            .eq('job_url', rawJobUrl)
            .maybeSingle();
          if (altData) supabaseRecord = altData;
        }
      } catch (err: any) {
        console.warn(`[Server] Error querying Supabase for candidate application ${applywizzId}:`, err.message);
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

    if (!appItem && (applywizzId === DEMO_APPLYWIZZ_ID || decodedUrl === DEMO_JOB_URL || rawJobUrl === DEMO_JOB_URL)) {
      appItem = demoApplication;
    }

    if (!appItem && applywizzId === AKSHITHA_APPLYWIZZ_ID) {
      appItem = loadSecondaryDemoArtifacts().applications.find(
        (a) =>
          a.jobUrl === decodedUrl ||
          a.jobUrl === rawJobUrl ||
          decodedUrl.includes(a.jobUrl) ||
          a.jobUrl.includes(decodedUrl)
      );
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
      const resolvedFields = supabaseRecord.resolved_fields || appItem?.resolvedFields || [];
      const status = supabaseRecord.status;
      const companyName = supabaseRecord.company_name || appItem?.companyName || '';
      const jobTitle = supabaseRecord.job_title || appItem?.jobTitle || '';
      const candidateName = (appItem as any)?.candidateName || '';

      cacheApplicationLocally({
        ...supabaseRecord,
        company_name: companyName,
        job_title: jobTitle,
      });

      res.json(
        serializeApplicationDto(supabaseRecord, {
          applywizz_id: applywizzId,
          job_url: supabaseRecord.job_url || decodedUrl,
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
  app.get('*', (_req: Request, res: Response) => {
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
  const app = createServer();

  const server = app.listen(port, '0.0.0.0', () => {
    wsManager.init(server);
    console.log('================================================================');
    console.log(`  🟢 Greenhouse Operator REST API & Dashboard Live on 0.0.0.0:${port}`);
    console.log('================================================================');
    console.log(`• URL:                http://0.0.0.0:${port}`);
    console.log(`• Candidate Stats:    /api/stats`);
    console.log(`• Candidate List:     /api/candidates`);
    console.log(`• Master Resumes:     /resumes/`);
    console.log('================================================================\n');

    logSupabaseCredentialIdentity('Server');

    if (config.ZOHO_CONNECTOR_USER && config.ZOHO_CONNECTOR_PASS) {
      zohoReader.init().catch((err: any) => {
        console.warn(`[Server] ⚠️ Zoho Reader background initialization error: ${err.message}`);
      });
    }

    // Launch background round-robin submission worker daemon if enabled (Phase V2-4c)
    let queueDaemon: SubmissionQueueDaemon | null = null;
    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      const concurrency = process.env.WORKER_CONCURRENCY ? parseInt(process.env.WORKER_CONCURRENCY, 10) : 2;
      console.log(
        `[Queue] ENABLE_QUEUE_WORKER=true — starting SubmissionQueueDaemon (WORKER_CONCURRENCY=${concurrency}, dequeue status=QUEUED)`
      );
      queueDaemon = new SubmissionQueueDaemon({ concurrency });
      queueDaemon.start();
    } else {
      console.warn(
        '[Queue] ENABLE_QUEUE_WORKER is not "true" — POST /submit will set status=QUEUED but no in-process worker will run'
      );
    }
  });

  const cleanup = async () => {
    await zohoReader.cleanup().catch(() => {});
    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      // Allow in-flight Playwright workers to finish
      console.log('[Server] 🧹 Shutting down background queue daemon...');
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
