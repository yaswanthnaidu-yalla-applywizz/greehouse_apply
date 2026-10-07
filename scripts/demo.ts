import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  AKSHITHA_APPLYWIZZ_ID,
  akshithaApplications,
  akshithaSegment,
  akshithaTemplates,
} from '../src/dashboard/akshithaDemoFixtures.js';
import type { CandidateJobApplication, CandidateSegment, ScannedJobTemplate } from '../src/types/index.js';

process.env.DEMO_MODE = 'true';

const DEMO_EMAIL = 'yaswanthnaiduyalla@applywizz.ai';
const PORT = Number(process.env.PORT || 3001);
const publicDir = path.resolve(process.cwd(), 'dashboard/public');
const app = express();

interface DemoUser {
  email: string;
  role: 'operator';
}

interface DemoRequest extends Request {
  user?: DemoUser;
}

interface DemoApplication extends CandidateJobApplication {
  id: string;
}

const candidateFixtures = new Map<string, CandidateSegment>();
const applicationFixtures = new Map<string, DemoApplication>();
const templateFixtures = new Map<string, ScannedJobTemplate>();

function applicationKey(applywizzId: string, jobUrl: string): string {
  return `${applywizzId.trim().toUpperCase()}::${jobUrl}`;
}

function seedFixtures(): void {
  candidateFixtures.set(AKSHITHA_APPLYWIZZ_ID, structuredClone(akshithaSegment));

  for (const [index, fixture] of akshithaApplications.entries()) {
    const application = {
      ...structuredClone(fixture),
      id: `demo-${AKSHITHA_APPLYWIZZ_ID}-${index + 1}`,
    };
    applicationFixtures.set(applicationKey(application.applywizzId, application.jobUrl), application);
  }

  for (const fixture of akshithaTemplates) {
    templateFixtures.set(fixture.jobUrl, structuredClone(fixture));
  }
}

function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true';
}

function injectDemoSession(req: DemoRequest, _res: Response, next: NextFunction): void {
  if (demoModeEnabled()) {
    req.user = { email: DEMO_EMAIL, role: 'operator' };
  }
  next();
}

function requireAuth(req: DemoRequest, res: Response, next: NextFunction): void {
  if (demoModeEnabled()) {
    next();
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  next();
}

function requireRole(role: DemoUser['role']) {
  return (req: DemoRequest, res: Response, next: NextFunction): void => {
    if (demoModeEnabled()) {
      next();
      return;
    }
    if (req.user?.role !== role) {
      res.status(403).json({ error: 'Forbidden.' });
      return;
    }
    next();
  };
}

function logSupabaseNoop(req: Request): void {
  console.info(`[Demo] No-op Supabase write: ${req.method} ${req.originalUrl}`);
}

function toJobRow(application: DemoApplication) {
  const fields = application.resolvedFields;
  return {
    id: application.id,
    applywizzId: application.applywizzId,
    rawUrl: application.jobUrl,
    canonicalUrl: application.jobUrl,
    jobUrl: application.jobUrl,
    companyName: application.companyName,
    jobTitle: application.jobTitle,
    status: application.status,
    fieldsCount: fields.length,
    resolved_fields: fields,
    resolvedFields: fields,
    hasManualEdits: fields.some((field) => field.source === 'manual'),
    eligibleForSubmission: true,
    questionLimitBlocked: false,
  };
}

function sendOperatorDashboard(_req: Request, res: Response): void {
  if (!demoModeEnabled()) {
    res.status(403).send('Demo mode is disabled.');
    return;
  }
  const indexPath = path.join(publicDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.status(404).send('Operator dashboard page not found.');
    return;
  }

  const sessionBootstrap = `<script>
    localStorage.setItem('applywizz_auth_token', 'demo-session');
    sessionStorage.setItem('applywizz_auth_token', 'demo-session');
    localStorage.setItem('applywizz_auth_user', ${JSON.stringify(JSON.stringify({
      email: DEMO_EMAIL,
      role: 'operator',
    }))});
  </script>`;
  const html = fs
    .readFileSync(indexPath, 'utf8')
    .replace('<script src="/roleAccess.js"></script>', `${sessionBootstrap}\n  <script src="/roleAccess.js"></script>`);
  res.type('html').send(html);
}

seedFixtures();

app.use(injectDemoSession);
app.use(express.json());

app.get('/', (_req, res) => {
  if (!demoModeEnabled()) {
    res.status(403).send('Demo mode is disabled.');
    return;
  }
  res.redirect(`/operator?candidate=${encodeURIComponent(AKSHITHA_APPLYWIZZ_ID)}`);
});
app.get('/operator', sendOperatorDashboard);
app.get('/roleAccess.js', (_req, res, next) => {
  if (!demoModeEnabled()) {
    next();
    return;
  }
  const roleAccessPath = path.join(publicDir, 'roleAccess.js');
  const source = fs.readFileSync(roleAccessPath, 'utf8');
  const demoRoleAccess = source.replace(
    "'yaswanthnaiduyalla@applywizz.ai': 'dev'",
    "'yaswanthnaiduyalla@applywizz.ai': 'operator'"
  );
  if (demoRoleAccess === source) {
    res.status(500).send('Demo role mapping could not be applied.');
    return;
  }
  res.type('application/javascript').send(demoRoleAccess);
});
app.use(express.static(publicDir, { index: false }));

app.use('/api', requireAuth, requireRole('operator'));

app.get('/api/candidates', (_req, res) => {
  const segment = candidateFixtures.get(AKSHITHA_APPLYWIZZ_ID)!;
  const candidateApplications = [...applicationFixtures.values()].filter(
    (application) => application.applywizzId === AKSHITHA_APPLYWIZZ_ID
  );
  const readyCount = candidateApplications.filter((application) => application.status === 'READY_FOR_REVIEW').length;
  res.json({
    candidates: [{
      applywizzId: segment.applywizzId,
      clientName: segment.clientName,
      email: segment.profile?.email || '',
      location: segment.profile?.location || '',
      totalJobs: candidateApplications.length,
      job_count: candidateApplications.length,
      queue_status: readyCount > 0 ? 'READY_FOR_REVIEW' : 'NO_APPLICATIONS',
      readyCount,
      expiredCount: 0,
      status: readyCount > 0 ? 'READY' : 'PENDING',
      syncedAt: segment.syncedAt,
      resumeAvailable: true,
    }],
    workHistoryUnreachable: false,
  });
});

app.get('/api/candidates/:applywizzId', (req, res) => {
  const segment = candidateFixtures.get(req.params.applywizzId.toUpperCase());
  if (!segment) {
    res.status(404).json({ error: `Candidate '${req.params.applywizzId}' not found.` });
    return;
  }
  res.json({
    applywizzId: segment.applywizzId,
    clientName: segment.clientName,
    profile: segment.profile,
    resumeUrl: null,
    resumeFilename: null,
    jobs: [...applicationFixtures.values()]
      .filter((application) => application.applywizzId === segment.applywizzId)
      .map(toJobRow),
  });
});

app.get('/api/candidates/:applywizzId/jobs', (req, res) => {
  const applywizzId = req.params.applywizzId.toUpperCase();
  const jobs = [...applicationFixtures.values()]
    .filter((application) => application.applywizzId === applywizzId)
    .map(toJobRow);
  res.json({ applywizzId, jobs });
});

app.get('/api/candidates/:applywizzId/jobs/*', (req, res) => {
  const applywizzId = req.params.applywizzId.toUpperCase();
  const rawJobUrl = String(req.params[0] || '');
  let jobUrl = rawJobUrl;
  try {
    jobUrl = decodeURIComponent(rawJobUrl);
  } catch {
    // Keep the Express-decoded value when the URL is not valid percent encoding.
  }
  const application = applicationFixtures.get(applicationKey(applywizzId, jobUrl));
  if (!application) {
    res.status(404).json({ error: 'Demo application not found.' });
    return;
  }
  res.json(application);
});

app.get('/api/stats', (_req, res) => {
  const applications = [...applicationFixtures.values()];
  res.json({
    totalCandidates: candidateFixtures.size,
    totalApplications: applications.length,
    submitted: applications.filter((application) => application.status === 'APPLIED').length,
    submittedCount: applications.filter((application) => application.status === 'APPLIED').length,
    applied: applications.filter((application) => application.status === 'APPLIED').length,
    failed: applications.filter((application) => application.status === 'FAILED').length,
  });
});

app.get('/api/notifications', (_req, res) => {
  res.json([]);
});

app.get('/api/config/supabase-realtime', (_req, res) => {
  res.json({ enabled: false, url: null, anonKey: null });
});

app.get('/api/applications/:applicationId', (req, res) => {
  const application = [...applicationFixtures.values()].find((item) => item.id === req.params.applicationId);
  if (!application) {
    res.status(404).json({ error: 'Demo application not found.' });
    return;
  }
  res.json(application);
});

app.patch('/api/applications/:applicationId/fields/:fieldKey', (req, res) => {
  const application = [...applicationFixtures.values()].find((item) => item.id === req.params.applicationId);
  if (!application) {
    res.status(404).json({ error: 'Demo application not found.' });
    return;
  }
  const field = application.resolvedFields.find(
    (item) => item.fieldId === req.params.fieldKey || item.name === req.params.fieldKey
  );
  if (!field || typeof req.body?.value !== 'string') {
    res.status(400).json({ error: 'Invalid demo field update.' });
    return;
  }

  field.value = req.body.value;
  field.source = 'manual';
  field.isEdited = true;
  logSupabaseNoop(req);
  res.json(field);
});

app.delete('/api/notifications/:notificationId', (req, res) => {
  logSupabaseNoop(req);
  res.json({ ok: true, demoMode: true });
});

app.delete('/api/notifications/all', (req, res) => {
  logSupabaseNoop(req);
  res.json({ ok: true, demoMode: true });
});

app.use('/api', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    logSupabaseNoop(req);
    res.json({ ok: true, demoMode: true, noop: true, message: 'No external action was performed.' });
    return;
  }
  res.status(404).json({ error: 'Demo endpoint not available.' });
});

app.listen(PORT, '0.0.0.0', () => {
  const demoCandidate = candidateFixtures.get(AKSHITHA_APPLYWIZZ_ID)!;
  console.info(`[Demo] Operator dashboard: http://localhost:${PORT}/`);
  console.info(`[Demo] Loaded ${demoCandidate.applywizzId} with ${applicationFixtures.size} in-memory application.`);
  console.info(`[Demo] In-memory templates: ${templateFixtures.size}; Supabase is not used.`);
});
