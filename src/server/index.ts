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
import { authRouter, ALWAYS_ALLOWED_EMAILS } from './routes/auth.js';
import { requireAuth, type AuthenticatedRequest } from './middleware/auth.js';
import { getCachedWorkHistory, setCachedWorkHistory } from './workHistoryCache.js';
import { fetchAllowedCandidates, type WorkHistoryCandidateRecord } from '../services/workHistoryClient.js';
import { cacheApplicationLocally } from '../db/applications.js';
import {
  demoApplication,
  demoSegment,
  demoTemplate,
  toApplicationRow,
  mergeDemoFixtures,
  DEMO_APPLYWIZZ_ID,
  DEMO_JOB_URL,
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
    [demoSegment, ...segments.filter((s) => s.applywizzId !== demoSegment.applywizzId)],
    [demoSegment],
    (s) => s.applywizzId
  );
  artifactCache.scannedJobs = mergeDemoFixtures(
    [demoTemplate, ...templates.filter((t) => t.jobUrl !== demoTemplate.jobUrl)],
    [demoTemplate],
    (t) => t.jobUrl
  );
  artifactCache.resolvedApplications = mergeDemoFixtures(
    [
      demoApplication,
      ...applications.filter(
        (a) => `${a.applywizzId}::${a.jobUrl}` !== `${demoApplication.applywizzId}::${demoApplication.jobUrl}`
      ),
    ],
    [demoApplication],
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
  app.get('/api/stats', (_req: Request, res: Response) => {
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

    const stats: DashboardStats = {
      totalCandidates: artifactCache.candidateSegments.length,
      totalApplications: artifactCache.resolvedApplications.length,
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
   * Returns summary list of all segregated candidates with job counts and status.
   */
  app.get('/api/candidates', async (req: AuthenticatedRequest, res: Response) => {
    const userEmail = (req.user?.email || '').trim().toLowerCase();
    const isAdmin = !userEmail || ALWAYS_ALLOWED_EMAILS.includes(userEmail);

    let allowedIds: Set<string> | null = null;
    let workHistoryRecords: WorkHistoryCandidateRecord[] = [];
    let workHistoryUnreachable = false;

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
      workHistoryUnreachable = cached.unreachable;
      workHistoryRecords = cached.records;
      allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));
    }

    res.setHeader('X-Work-History-Unreachable', String(workHistoryUnreachable));

    // 1. Process candidateSegments
    const matchedSegments = artifactCache.candidateSegments.filter(
      (seg) => !allowedIds || allowedIds.has(seg.applywizzId.toUpperCase())
    );

    const candidateSummaries: CandidateSummary[] = matchedSegments.map((seg) => {
      const candidateApps = artifactCache.resolvedApplications.filter(
        (a) => a.applywizzId === seg.applywizzId
      );
      const readyCount = candidateApps.filter((a) => a.status === 'READY_FOR_REVIEW').length;
      const expiredCount = candidateApps.filter((a) => a.status === 'EXPIRED').length;

      // Filter to only jobs eligible under current question threshold (< MAX_JOB_QUESTIONS)
      const eligibleJobs = seg.jobs.filter((job) => {
        if (seg.applywizzId === DEMO_APPLYWIZZ_ID || job.canonicalUrl === DEMO_JOB_URL || job.rawUrl === DEMO_JOB_URL) {
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
    if (!isAdmin && workHistoryRecords.length > 0) {
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

    if (isAdmin && !candidateSummaries.some((c) => c.applywizzId === DEMO_APPLYWIZZ_ID)) {
      candidateSummaries.unshift({
        applywizzId: demoSegment.applywizzId,
        clientName: demoSegment.clientName,
        email: demoSegment.profile?.email || '',
        location: demoSegment.profile?.location || '',
        totalJobs: 1,
        readyCount: 1,
        expiredCount: 0,
        status: 'READY',
        syncedAt: demoSegment.syncedAt,
        resumeAvailable: true,
      });
    }

    // For unauthenticated / testing environments without headers, return flat array for backward-compatibility
    if (!userEmail && (process.env.NODE_ENV === 'test' || !req.headers.authorization)) {
      res.json(candidateSummaries);
      return;
    }

    if (!isAdmin && candidateSummaries.length === 0) {
      res.json({
        candidates: [],
        message: 'No candidates were assigned to you on your most recent working day.',
        workHistoryUnreachable,
      });
      return;
    }

    res.json({
      candidates: candidateSummaries,
      workHistoryUnreachable,
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
    const userEmail = (req.user?.email || '').trim().toLowerCase();
    const isAdmin = !userEmail || ALWAYS_ALLOWED_EMAILS.includes(userEmail);

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

    const seg = candidatesMap.get(applywizzId) || (applywizzId === DEMO_APPLYWIZZ_ID ? demoSegment : undefined);

    if (!seg) {
      // Check if it's a synthesized candidate from work-history
      let whRecord: WorkHistoryCandidateRecord | undefined;
      if (!isAdmin) {
        const cached = getCachedWorkHistory(userEmail);
        whRecord = cached?.records.find((r) => r.applywizzId.toUpperCase() === applywizzId.toUpperCase());
      }
      if (whRecord) {
        const resumeFilename = `${applywizzId}_resume.pdf`;
        const resumeExists = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilename));
        res.json({
          applywizzId: whRecord.applywizzId,
          clientName: whRecord.clientName,
          profile: { email: whRecord.clientEmail },
          resumeUrl: resumeExists ? `/resumes/${resumeFilename}` : null,
          resumeFilename: resumeExists ? resumeFilename : null,
          jobs: [],
        });
        return;
      }

      res.status(404).json({ error: `Candidate with Applywizz ID '${applywizzId}' not found.` });
      return;
    }

    const resumeFilename = `${applywizzId}_resume.pdf`;
    const resumeExists = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilename));

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
      resumeUrl: resumeExists ? `/resumes/${resumeFilename}` : null,
      resumeFilename: resumeExists ? resumeFilename : null,
      jobs: eligibleJobsWithStatus,
    });
  });

  /**
   * GET /api/candidates/:applywizzId/jobs/*
   * Returns resolved CandidateJobApplication record for the specified candidate and job URL.
   */
  app.get('/api/candidates/:applywizzId/jobs/*', async (req: AuthenticatedRequest, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
    const userEmail = (req.user?.email || '').trim().toLowerCase();
    const isAdmin = !userEmail || ALWAYS_ALLOWED_EMAILS.includes(userEmail);

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

    let decodedUrl = decodeURIComponent(rawJobUrl);
    if (decodedUrl.includes('grnh.se')) {
      decodedUrl = await resolveShortlink(decodedUrl);
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
            decodedUrl.includes(a.jobUrl) ||
            a.jobUrl.includes(decodedUrl))
      );
    }

    if (!appItem && (applywizzId === DEMO_APPLYWIZZ_ID || decodedUrl === DEMO_JOB_URL || rawJobUrl === DEMO_JOB_URL)) {
      appItem = demoApplication;
    }

    if (appItem) {
      res.json(appItem);
      return;
    }

    // 3. Fallback: construct application payload from template if available
    const template =
      templatesMap.get(decodedUrl) ||
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
  });

  const cleanup = async () => {
    await zohoReader.cleanup().catch(() => {});
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  return server;
}

// Auto-start when executed directly
if (process.argv[1] && process.argv[1].includes('server')) {
  startServer();
}
