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
import { wsManager } from './ws.js';
import { requireAuth, type AuthenticatedRequest } from './middleware/auth.js';
import { getCachedWorkHistory, setCachedWorkHistory } from './workHistoryCache.js';
import {
  fetchAllowedCandidates,
  fetchWorkHistoryForDate,
  fetchAdminWorkHistoryForDate,
  ADMIN_WORK_HISTORY_CACHE_KEY,
  getISTDateString,
  type WorkHistoryCandidateRecord,
} from '../services/workHistoryClient.js';
import { hydrateAdminProfilesFromWorkHistory } from '../services/adminProfileHydrate.js';
import { cacheApplicationLocally, getSubmissionOutcomeCounts, getApplication, upsertApplication, serializeApplicationDto } from '../db/applications.js';
import { getSignedResumeUrl, downloadResumeFromSupabase } from '../db/storage.js';
import { isSupabaseConfigured, getDbClient } from '../db/client.js';
import { SubmissionQueueDaemon } from '../submitter/queueWorker.js';
import {
  demoApplication,
  demoSegment,
  demoTemplate,
  akshithaSegment,
  akshithaApplications,
  akshithaTemplates,
  toApplicationRow,
  mergeDemoFixtures,
  DEMO_APPLYWIZZ_ID,
  DEMO_JOB_URL,
  AKSHITHA_APPLYWIZZ_ID,
} from '../dashboard/demoFixtures.js';
import { zohoReader } from '../services/zohoReader.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedJobTemplate,
} from '../types/index.js';

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

  artifactCache.candidateSegments = mergeDemoFixtures(
    [
      demoSegment,
      akshithaSegment,
      ...segments.filter(
        (s) => s.applywizzId !== demoSegment.applywizzId && s.applywizzId !== akshithaSegment.applywizzId
      ),
    ],
    [demoSegment, akshithaSegment],
    (s) => s.applywizzId
  );
  artifactCache.scannedJobs = mergeDemoFixtures(
    [
      demoTemplate,
      ...akshithaTemplates,
      ...templates.filter(
        (t) => t.jobUrl !== demoTemplate.jobUrl && !akshithaTemplates.some((at) => at.jobUrl === t.jobUrl)
      ),
    ],
    [demoTemplate, ...akshithaTemplates],
    (t) => t.jobUrl
  );
  artifactCache.resolvedApplications = mergeDemoFixtures(
    [
      demoApplication,
      ...akshithaApplications,
      ...applications.filter(
        (a) =>
          `${a.applywizzId}::${a.jobUrl}` !== `${demoApplication.applywizzId}::${demoApplication.jobUrl}` &&
          !akshithaApplications.some((aa) => `${a.applywizzId}::${a.jobUrl}` === `${aa.applywizzId}::${aa.jobUrl}`)
      ),
    ],
    [demoApplication, ...akshithaApplications],
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

/**
 * Creates and configures the Express application instance.
 *
 * @returns Configured Express application.
 */
export function createServer(outputDir: string = config.OUTPUT_DIR): express.Application {
  loadArtifacts(outputDir, { log: true });
  const app = express();

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

    const user = (req as any).user;
    const userEmail = (user?.email || '').trim().toLowerCase();
    const isAdmin = isUserAdmin(user || userEmail);

    let allowedCandidateIds: string[] | undefined = undefined;
    if (!isAdmin) {
      const targetDate = dateParam || getISTDateString(0);
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
   */
  app.post('/api/admin/trigger-ingest-from-storage', async (_req: Request, res: Response) => {
    try {
      const { ingestCsvFromStorage } = await import('../scanner/storageCsvIngestion.js');
      const result = await ingestCsvFromStorage();
      if (result.processedCount > 0) {
        loadArtifacts(outputDir);
      }
      res.json(result);
    } catch (err: any) {
      console.error('[Admin] Storage CSV ingestion failed:', err);
      res.status(500).json({ error: err.message || 'Storage ingestion failed' });
    }
  });

  /**
   * GET /api/candidates
   * Returns summary list of all segregated candidates with job counts and status for the selected IST date.
   */
  app.get('/api/candidates', async (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    const userEmail = (user?.email || '').trim().toLowerCase();
    const isAdmin = isUserAdmin(user || userEmail);

    const dateParam = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : getISTDateString(0);

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
    } else {
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

      const akshithaSummary: CandidateSummary = {
        applywizzId: akshithaSegment.applywizzId,
        clientName: akshithaSegment.clientName,
        email: akshithaSegment.profile?.email || 'akshitha.reddy@applywizard.ai',
        location: akshithaSegment.profile?.location || 'Dallas, Texas, United States',
        totalJobs: akshithaSegment.jobs.length,
        readyCount: akshithaSegment.jobs.length,
        expiredCount: 0,
        status: 'READY',
        syncedAt: akshithaSegment.syncedAt,
        resumeAvailable: true,
      };

      candidateSummaries = [demoSummary, akshithaSummary, ...nonDemoSummaries];
    }

    // For unauthenticated / testing environments without headers, return flat array for backward-compatibility
    if (!userEmail && (process.env.NODE_ENV === 'test' || !req.headers.authorization)) {
      res.json(candidateSummaries);
      return;
    }

    if (!isAdmin && candidateSummaries.length === 0) {
      res.json({
        candidates: [],
        message: `No candidates were assigned to you on ${dateParam}.`,
        workHistoryUnreachable,
        selectedDate: dateParam,
      });
      return;
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
    const user = req.user;
    const userEmail = (user?.email || '').trim().toLowerCase();
    const isAdmin = isUserAdmin(user || userEmail);

    if (!isAdmin) {
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

    const seg =
      candidatesMap.get(applywizzId) ||
      (applywizzId === DEMO_APPLYWIZZ_ID
        ? demoSegment
        : applywizzId === AKSHITHA_APPLYWIZZ_ID
        ? akshithaSegment
        : undefined);

    if (!seg) {
      // Check if it's a synthesized candidate from work-history
      let whRecord: WorkHistoryCandidateRecord | undefined;
      if (!isAdmin) {
        const cached = getCachedWorkHistory(userEmail);
        whRecord = cached?.records.find((r) => r.applywizzId.toUpperCase() === applywizzId.toUpperCase());
      }
      if (whRecord) {
        const resumeFilenameLocal = `${applywizzId}_resume.pdf`;
        const resumeExistsLocal = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilenameLocal));
        let resumeUrl: string | null = null;
        let resumeFilename: string | null = null;

        if (isSupabaseConfigured()) {
          try {
            const signed = await getSignedResumeUrl(`${applywizzId}_resume.pdf`);
            if (signed) {
              resumeUrl = signed;
              resumeFilename = `${applywizzId}_resume.pdf`;
            }
          } catch {}
        }

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
    let resumeUrl: string | null = null;
    let resumeFilename: string | null = null;

    const candidateStoragePath =
      seg.profile?.resumeUrl ||
      seg.profile?.localResumePath ||
      (applywizzId === DEMO_APPLYWIZZ_ID || applywizzId === 'AWL-YASHANTH'
        ? 'resumes/AWL-YASHANTH_resume.pdf'
        : `${applywizzId}_resume.pdf`);

    if (isSupabaseConfigured()) {
      try {
        const signed = await getSignedResumeUrl(candidateStoragePath);
        if (signed) {
          resumeUrl = signed;
          resumeFilename = path.basename(candidateStoragePath);
        }
      } catch {}
    }

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
      .filter((job) => seg.applywizzId === DEMO_APPLYWIZZ_ID || job.canonicalUrl === DEMO_JOB_URL || job.fieldsCount < config.MAX_JOB_QUESTIONS);

    res.json({
      applywizzId: seg.applywizzId,
      clientName: seg.clientName,
      profile: seg.profile,
      resumeUrl,
      resumeFilename,
      jobs: eligibleJobsWithStatus,
    });
  });

  /**
   * GET /api/candidates/:applywizzId/resume
   * Streams or serves candidate master resume PDF directly from Supabase Storage or local cache.
   */
  app.get('/api/candidates/:applywizzId/resume', async (req: AuthenticatedRequest, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');

    const targetPath = (applywizzId === DEMO_APPLYWIZZ_ID || applywizzId === 'AWL-YASHANTH')
      ? 'resumes/AWL-YASHANTH_resume.pdf'
      : `${applywizzId}_resume.pdf`;

    const buffer = await downloadResumeFromSupabase(targetPath);
    if (buffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${applywizzId}_resume.pdf"`);
      res.send(buffer);
      return;
    }

    const localCandidates = [
      path.resolve(process.cwd(), config.RESUMES_DIR, `${applywizzId}_resume.pdf`),
      path.resolve(process.cwd(), config.RESUMES_DIR, 'AWL-YASHANTH_resume.pdf'),
      path.resolve(process.cwd(), config.RESUMES_DIR, 'my-resume.pdf'),
      path.resolve(process.cwd(), config.RESUMES_DIR, 'my-resume.pdf.pdf'),
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
    const user = req.user;
    const userEmail = (user?.email || '').trim().toLowerCase();
    const isAdmin = isUserAdmin(user || userEmail);

    if (!isAdmin) {
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
      appItem = akshithaApplications.find(
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

    if (config.ZOHO_CONNECTOR_USER && config.ZOHO_CONNECTOR_PASS) {
      zohoReader.init().catch((err: any) => {
        console.warn(`[Server] ⚠️ Zoho Reader background initialization error: ${err.message}`);
      });
    }

    // Launch background round-robin submission worker daemon if enabled (Phase V2-4c)
    let queueDaemon: SubmissionQueueDaemon | null = null;
    if (process.env.ENABLE_QUEUE_WORKER === 'true') {
      const concurrency = process.env.WORKER_CONCURRENCY ? parseInt(process.env.WORKER_CONCURRENCY, 10) : 2;
      queueDaemon = new SubmissionQueueDaemon({ concurrency });
      queueDaemon.start();
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
