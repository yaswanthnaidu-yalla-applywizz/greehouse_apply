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

import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { resolveShortlink } from '../scanner/csvDeduplicator.js';
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
 * In-memory state cache loaded from disk artifacts.
 */
interface ServerState {
  segments: CandidateSegment[];
  templates: ScannedJobTemplate[];
  applications: CandidateJobApplication[];
  candidatesMap: Map<string, CandidateSegment>;
  templatesMap: Map<string, ScannedJobTemplate>;
  applicationsMap: Map<string, CandidateJobApplication>;
}

const state: ServerState = {
  segments: [],
  templates: [],
  applications: [],
  candidatesMap: new Map(),
  templatesMap: new Map(),
  applicationsMap: new Map(),
};

/**
 * Loads generated artifact files from disk into memory.
 */
export function loadArtifacts(outputDir: string = config.OUTPUT_DIR): void {
  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);

  const segmentsPath = path.join(resolvedOutputDir, 'candidate_segments.json');
  const templatesPath = path.join(resolvedOutputDir, 'scanned_jobs.json');
  const applicationsPath = path.join(resolvedOutputDir, 'resolved_applications.json');

  state.candidatesMap.clear();
  state.templatesMap.clear();
  state.applicationsMap.clear();

  // 1. Load Candidate Segments
  if (fs.existsSync(segmentsPath)) {
    try {
      const raw = fs.readFileSync(segmentsPath, 'utf-8');
      state.segments = JSON.parse(raw);
      for (const seg of state.segments) {
        state.candidatesMap.set(seg.applywizzId, seg);
      }
      console.log(`[Express API] 📂 Loaded ${state.segments.length} candidate segments.`);
    } catch (err: any) {
      console.warn(`[Express API] ⚠️ Failed to read ${segmentsPath}: ${err.message}`);
    }
  }

  // 2. Load Scanned Job Templates
  if (fs.existsSync(templatesPath)) {
    try {
      const raw = fs.readFileSync(templatesPath, 'utf-8');
      state.templates = JSON.parse(raw);
      for (const t of state.templates) {
        state.templatesMap.set(t.jobUrl, t);
      }
      console.log(`[Express API] 📂 Loaded ${state.templates.length} scanned job templates.`);
    } catch (err: any) {
      console.warn(`[Express API] ⚠️ Failed to read ${templatesPath}: ${err.message}`);
    }
  }

  // 3. Load Resolved Applications
  if (fs.existsSync(applicationsPath)) {
    try {
      const raw = fs.readFileSync(applicationsPath, 'utf-8');
      state.applications = JSON.parse(raw);
      for (const app of state.applications) {
        const key = `${app.applywizzId}::${app.jobUrl}`;
        state.applicationsMap.set(key, app);
      }
      console.log(`[Express API] 📂 Loaded ${state.applications.length} resolved job applications.`);
    } catch (err: any) {
      console.warn(`[Express API] ⚠️ Failed to read ${applicationsPath}: ${err.message}`);
    }
  }
}

/**
 * Creates and configures the Express application instance.
 *
 * @returns Configured Express application.
 */
export function createServer(): express.Application {
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
        candidates: state.segments.length,
        templates: state.templates.length,
        applications: state.applications.length,
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

    for (const appItem of state.applications) {
      for (const f of appItem.resolvedFields) {
        totalFields++;
        if (f.source === 'supabase') supabaseCount++;
        if (f.source === 'ai') aiCount++;
      }
    }

    const stats: DashboardStats = {
      totalCandidates: state.segments.length,
      totalApplications: state.applications.length,
      uniqueScannedJobs: state.templates.length,
      totalFieldsPopulated: totalFields,
      supabaseTaggedCount: supabaseCount,
      aiTaggedCount: aiCount,
      supabasePercentage: totalFields ? Number(((supabaseCount / totalFields) * 100).toFixed(1)) : 0,
      aiPercentage: totalFields ? Number(((aiCount / totalFields) * 100).toFixed(1)) : 0,
      pipelineStatus: state.applications.length > 0 ? 'READY' : 'IDLE',
    };

    res.json(stats);
  });

  /**
   * GET /api/candidates
   * Returns summary list of all segregated candidates with job counts and status.
   */
  app.get('/api/candidates', (_req: Request, res: Response) => {
    const candidateSummaries: CandidateSummary[] = state.segments.map((seg) => {
      const candidateApps = state.applications.filter((a) => a.applywizzId === seg.applywizzId);
      const readyCount = candidateApps.filter((a) => a.status === 'READY_FOR_REVIEW').length;
      const expiredCount = candidateApps.filter((a) => a.status === 'EXPIRED').length;

      const resumePath = path.join(config.RESUMES_DIR, `${seg.applywizzId}_resume.pdf`);
      const resumeAvailable = fs.existsSync(resumePath);

      let status: 'READY' | 'PENDING' | 'EXPIRED' = 'PENDING';
      if (readyCount > 0) {
        status = 'READY';
      } else if (expiredCount === seg.jobs.length && seg.jobs.length > 0) {
        status = 'EXPIRED';
      }

      return {
        applywizzId: seg.applywizzId,
        clientName: seg.clientName,
        email: seg.profile?.email || '',
        location: seg.profile?.location || '',
        totalJobs: seg.jobs.length,
        readyCount,
        expiredCount,
        status,
        syncedAt: seg.syncedAt,
        resumeAvailable,
      };
    });

    res.json(candidateSummaries);
  });

  /**
   * GET /api/candidates/:applywizzId
   * Returns candidate full profile, resume details, and assigned job queue.
   */
  app.get('/api/candidates/:applywizzId', (req: Request, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
    const seg = state.candidatesMap.get(applywizzId);

    if (!seg) {
      res.status(404).json({ error: `Candidate with Applywizz ID '${applywizzId}' not found.` });
      return;
    }

    const resumeFilename = `${applywizzId}_resume.pdf`;
    const resumeExists = fs.existsSync(path.join(config.RESUMES_DIR, resumeFilename));

    const candidateApps = state.applications.filter((a) => a.applywizzId === applywizzId);

    // Enrich jobs with resolved application status and metadata
    const jobsWithStatus = seg.jobs.map((job) => {
      const canonical = job.canonicalUrl || job.rawUrl;
      const appItem =
        candidateApps.find(
          (a) =>
            a.jobUrl === canonical ||
            canonical.includes(a.jobUrl) ||
            a.jobUrl.includes(canonical)
        ) ||
        state.applicationsMap.get(`${applywizzId}::${canonical}`) ||
        state.applicationsMap.get(`${applywizzId}::${job.rawUrl}`);

      const template =
        state.templatesMap.get(canonical) ||
        state.templatesMap.get(job.rawUrl) ||
        Array.from(state.templatesMap.values()).find(
          (t) => t.jobUrl.includes(canonical) || canonical.includes(t.jobUrl)
        );

      return {
        ...job,
        canonicalUrl: appItem?.jobUrl || canonical,
        companyName: appItem?.companyName || template?.companyName || 'Greenhouse Company',
        jobTitle: appItem?.jobTitle || template?.jobTitle || 'Job Opening',
        status: appItem?.status || (template?.isExpired ? 'EXPIRED' : 'PENDING'),
        fieldsCount: appItem?.resolvedFields.length || template?.fields.length || 0,
      };
    });

    res.json({
      applywizzId: seg.applywizzId,
      clientName: seg.clientName,
      profile: seg.profile,
      resumeUrl: resumeExists ? `/resumes/${resumeFilename}` : null,
      resumeFilename: resumeExists ? resumeFilename : null,
      jobs: jobsWithStatus,
    });
  });

  /**
   * GET /api/candidates/:applywizzId/jobs/*
   * Returns resolved CandidateJobApplication record for the specified candidate and job URL.
   */
  app.get('/api/candidates/:applywizzId/jobs/*', async (req: Request, res: Response) => {
    const applywizzId = Array.isArray(req.params.applywizzId)
      ? req.params.applywizzId[0]
      : String(req.params.applywizzId || '');
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
      state.applicationsMap.get(`${applywizzId}::${decodedUrl}`) ||
      state.applicationsMap.get(`${applywizzId}::${rawJobUrl}`);

    // 2. Candidate applications match
    if (!appItem) {
      appItem = state.applications.find(
        (a) =>
          a.applywizzId === applywizzId &&
          (a.jobUrl === decodedUrl ||
            decodedUrl.includes(a.jobUrl) ||
            a.jobUrl.includes(decodedUrl))
      );
    }

    if (appItem) {
      res.json(appItem);
      return;
    }

    // 3. Fallback: construct application payload from template if available
    const template =
      state.templatesMap.get(decodedUrl) ||
      Array.from(state.templatesMap.values()).find(
        (t) => t.jobUrl.includes(decodedUrl) || decodedUrl.includes(t.jobUrl)
      );

    const seg = state.candidatesMap.get(applywizzId);

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
        <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem;">
          <h1>🟢 Greenhouse Job Application Automation API (Port ${config.PORT})</h1>
          <p>API Server is running. Endpoints:</p>
          <ul>
            <li><a style="color: #38bdf8;" href="/api/stats">GET /api/stats</a></li>
            <li><a style="color: #38bdf8;" href="/api/candidates">GET /api/candidates</a></li>
            <li><a style="color: #38bdf8;" href="/api/health">GET /api/health</a></li>
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
export function startServer(port: number = config.PORT || 3001): ReturnType<express.Application['listen']> {
  loadArtifacts();
  const app = createServer();

  const server = app.listen(port, () => {
    console.log('================================================================');
    console.log(`  🟢 Greenhouse Operator REST API & Dashboard Live`);
    console.log('================================================================');
    console.log(`• Local URL:          http://localhost:${port}`);
    console.log(`• Candidate Stats:    http://localhost:${port}/api/stats`);
    console.log(`• Candidate List:     http://localhost:${port}/api/candidates`);
    console.log(`• Master Resumes:     http://localhost:${port}/resumes/`);
    console.log('================================================================\n');
  });

  return server;
}

// Auto-start when executed directly
if (process.argv[1] && process.argv[1].includes('server')) {
  startServer(config.PORT || 3001);
}
