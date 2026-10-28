import fs from 'fs';
import path from 'path';
import { Router, type Response } from 'express';
import { config } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { getAuthenticatedCaEmail } from '../workHistoryAuth.js';
import {
  ADMIN_WORK_HISTORY_CACHE_KEY,
  getISTDateString,
  type WorkHistoryCandidateRecord,
} from '../../services/workHistoryClient.js';
import { sanitizeHttpHeaderValue } from '../httpHeaders.js';
import { mergeWorkHistoryForIstDates } from '../workHistorySpan.js';
import {
  applicationAssignedCaAllowedForRequest,
  hasUnrestrictedDashboardAccess,
  isApplywizzIdInDashboardAccess,
  resolveDashboardCandidateAccess,
  resolveRequestAppRole,
  resolveViewAsOperatorManagerEmail,
} from '../managerTeamScope.js';
import {
  applicationRowHasPersistedResolution,
  filterOperatorApplicationJobs,
} from '../../dashboard/candidateQueueFilter.js';
import { fetchProfileListingFieldsByApplywizzIds } from '../../db/profiles.js';
import { fetchResumePdfBuffer, getProfileResumeHttpUrl, isDemoResumeApplywizzId } from '../../db/storage.js';
import { isSupabaseConfigured, getDbClient } from '../../db/client.js';
import {
  assertApplywizzZohoConnected,
  fetchZohoConnectedApplywizzIdSet,
} from '../../db/zohoConnected.js';
import { isSandboxMode } from '../../db/sandboxClient.js';
import { resolveShortlink } from '../../scanner/csvDeduplicator.js';
import {
  cacheApplicationLocally,
  applyCreatedAtRangeFilter,
  getApplication,
  upsertApplication,
  serializeApplicationDto,
  hydrateAndPersistApplicationFields,
  fetchCandidateApplicationAggregatesByApplywizzIds,
  distinctApplywizzIdsForCreatedAtRange,
  type ApplicationRow,
  type CandidateQueueStatus,
} from '../../db/applications.js';
import {
  istDatesForWorkHistory,
  parseDashboardCreatedAtRange,
  serializeDateRange,
} from '../dashboardDateRange.js';
import {
  demoApplication,
  demoSegment,
  toApplicationRow,
  DEMO_APPLYWIZZ_ID,
  DEMO_JOB_URL,
  AKSHITHA_APPLYWIZZ_ID,
  loadSecondaryDemoArtifacts,
  inMemoryDemoJobRowsForDashboard,
} from '../../dashboard/demoFixtures.js';
import type {
  CandidateJobApplication,
  CandidateSegment,
  ScannedJobTemplate,
} from '../../types/index.js';

const log = createLogger('CandidatesRoute');

async function assertCandidateZohoConnectedForViewing(
  applywizzId: string,
  options: { isAdmin?: boolean; allowAdminDemo?: boolean }
): Promise<{ allowed: boolean; error?: string }> {
  if (isSandboxMode()) return { allowed: true };
  return assertApplywizzZohoConnected(applywizzId, options);
}

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

export const candidatesMap = new Map<string, CandidateSegment>();
export const templatesMap = new Map<string, ScannedJobTemplate>();
export const applicationsMap = new Map<string, CandidateJobApplication>();

export function rebuildLookupMaps(): void {
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

function enrichResolvedFieldsWithTemplateOptions(
  fields: unknown,
  template?: ScannedJobTemplate
): Array<Record<string, unknown>> {
  if (!Array.isArray(fields)) return [];
  const scannedFields = template?.fields || [];
  return fields.map((field) => {
    if (!field || typeof field !== 'object') return field as Record<string, unknown>;
    const current = field as Record<string, unknown>;
    const type = String(current.type || current.field_type || '').toLowerCase();
    if (!['select', 'radio', 'checkbox'].includes(type)) return current;
    const scanned = scannedFields.find(
      (candidate) =>
        candidate.fieldId === current.fieldId ||
        candidate.name === current.name ||
        candidate.label === current.label
    );
    return {
      ...current,
      options: Array.isArray(scanned?.options)
        ? scanned.options
        : Array.isArray(current.options)
          ? current.options
          : [],
      ...(typeof scanned?.optionsComplete === 'boolean'
        ? { optionsComplete: scanned.optionsComplete }
        : typeof current.optionsComplete === 'boolean'
          ? { optionsComplete: current.optionsComplete }
          : {}),
    };
  });
}

export const candidatesRouter = Router({ mergeParams: true });

/**
 * GET /api/candidates
 * Returns summary list of all segregated candidates with job counts and status for the selected IST date.
 */
candidatesRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const userEmail = getAuthenticatedCaEmail(req);
  const role = resolveRequestAppRole(req, userEmail);
  const viewAsManagerEmail = resolveViewAsOperatorManagerEmail(req);
  const unrestricted = hasUnrestrictedDashboardAccess(role) && !viewAsManagerEmail;

  const query = req.query as Record<string, unknown>;
  const hasExplicitDateRange =
    query.from !== undefined ||
    query.to !== undefined ||
    query.date !== undefined ||
    query.range !== undefined;
  const rangeQuery = hasExplicitDateRange
    ? query
    : { ...query, from: getISTDateString(1), to: getISTDateString(1) };
  const parsedRange = parseDashboardCreatedAtRange(rangeQuery);
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
candidatesRouter.get('/:applywizzId', async (req: AuthenticatedRequest, res: Response) => {
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

  const zohoGate = await assertCandidateZohoConnectedForViewing(applywizzId, {
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
        eligibleForSubmission: true,
      };
    });

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
 * GET /api/candidates/:applywizzId/jobs
 * Returns only jobs belonging to the requested candidate, isolated to authenticated CA.
 */
candidatesRouter.get('/:applywizzId/jobs', async (req: AuthenticatedRequest, res: Response) => {
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

  const zohoGate = await assertCandidateZohoConnectedForViewing(applywizzId, {
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

  let jobs: Array<Record<string, unknown>> = [];
  let dbRowCount = 0;
  let skippedCaAssignment = 0;
  let skippedUnresolved = 0;

  if (isSupabaseConfigured()) {
    // Partitioned DTO: Preserve full detail (select('*') including resolved_fields, user_inputs)
    // for operator review card rendering and FormRenderer.tsx
    let appQuery = getDbClient()
      .from('gh_candidate_applications')
      .select('*')
      .eq('applywizz_id', applywizzId)
      .neq('status', 'FILTERED_OUT');

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
    const jobUrls = Array.from(
      new Set((data || []).map((application) => String(application.job_url || '').trim()).filter(Boolean))
    );
    const templatesByJobUrl = new Map<string, ScannedJobTemplate>();
    if (jobUrls.length > 0) {
      const { data: templates, error: templatesError } = await getDbClient()
        .from('gh_scanned_job_templates')
        .select('job_url, fields_schema')
        .in('job_url', jobUrls);
      if (templatesError) {
        log.warn(`[API] Failed to fetch field options for ${applywizzId}: ${templatesError.message}`);
      } else {
        for (const template of templates || []) {
          templatesByJobUrl.set(String(template.job_url), {
            jobUrl: String(template.job_url),
            fields: Array.isArray(template.fields_schema) ? template.fields_schema : [],
          } as ScannedJobTemplate);
        }
      }
    }
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
      const template = templatesByJobUrl.get(String(application.job_url || ''));
      jobs.push({
        id: application.id,
        rawUrl: application.job_url,
        canonicalUrl: application.job_url,
        companyName: application.company_name || 'Greenhouse Company',
        jobTitle: application.job_title || 'Job Opening',
        status: jobStatus,
        error_message: application.error_message ?? null,
        fieldsCount,
        resolved_fields: enrichResolvedFieldsWithTemplateOptions(application.resolved_fields, template),
        hasManualEdits: Boolean(application.has_manual_edits),
        eligibleForSubmission: true,
        questionLimitBlocked: false,
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

  jobs = filterOperatorApplicationJobs(jobs);

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
candidatesRouter.get('/:applywizzId/resume', async (req: AuthenticatedRequest, res: Response) => {
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
candidatesRouter.get('/:applywizzId/jobs/*', async (req: AuthenticatedRequest, res: Response) => {
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

  const zohoJobGate = await assertCandidateZohoConnectedForViewing(applywizzId, {
    isAdmin: unrestricted,
    allowAdminDemo: true,
  });
  if (!zohoJobGate.allowed) {
    res.status(403).json({ error: zohoJobGate.error });
    return;
  }

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
      log.warn(`[CandidatesRoute] Error querying Supabase for candidate application ${applywizzId}:`, err.message);
    }
  }

  let appItem =
    applicationsMap.get(`${applywizzId}::${decodedUrl}`) ||
    applicationsMap.get(`${applywizzId}::${rawJobUrl}`);

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

  let resolvedTemplate =
    templatesMap.get(decodedUrl) ||
    templatesMap.get(lookupUrl) ||
    Array.from(templatesMap.values()).find(
      (t) => t.jobUrl.includes(decodedUrl) || decodedUrl.includes(t.jobUrl)
    );
  if (!resolvedTemplate && isSupabaseConfigured()) {
    const templateUrls = Array.from(new Set([decodedUrl, lookupUrl, rawJobUrl].filter(Boolean)));
    const { data: templateRows, error: templateError } = await getDbClient()
      .from('gh_scanned_job_templates')
      .select('job_url, fields_schema')
      .in('job_url', templateUrls);
    if (templateError) {
      log.warn(`[CandidatesRoute] Failed to fetch field options for ${applywizzId}: ${templateError.message}`);
    } else if (templateRows?.[0]) {
      resolvedTemplate = {
        jobUrl: String(templateRows[0].job_url),
        fields: Array.isArray(templateRows[0].fields_schema) ? templateRows[0].fields_schema : [],
      } as ScannedJobTemplate;
    }
  }

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

    const resolvedFields = enrichResolvedFieldsWithTemplateOptions(
      row.resolved_fields?.length ? row.resolved_fields : appItem?.resolvedFields || [],
      resolvedTemplate
    );
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
    let resolvedFields = enrichResolvedFieldsWithTemplateOptions(appItem.resolvedFields, resolvedTemplate);
    let status = appItem.status;
    let proofWebUrl = (appItem as any).proofWebUrl || (appItem as any).proof_web_url;
    let dryRunScreenshotUrl = (appItem as any).dryRunScreenshotUrl || (appItem as any).dry_run_screenshot_url;
    let hasManualEdits = (appItem as any).hasManualEdits || (appItem as any).has_manual_edits;

    try {
      const memApp = (await getApplication(rowId, appItem.jobUrl)) || (await getApplication(appItem.applywizzId, appItem.jobUrl));
      if (memApp) {
        if (Array.isArray(memApp.resolved_fields) && memApp.resolved_fields.length > 0) {
          resolvedFields = enrichResolvedFieldsWithTemplateOptions(memApp.resolved_fields, resolvedTemplate);
        }
        if (memApp.status) status = memApp.status as any;
        if (memApp.proof_web_url) proofWebUrl = memApp.proof_web_url;
        if (memApp.dry_run_screenshot_url) dryRunScreenshotUrl = memApp.dry_run_screenshot_url;
        if (memApp.has_manual_edits !== undefined) hasManualEdits = memApp.has_manual_edits;
      }
    } catch {}

    let persistedRow: any = null;
    try {
      persistedRow = await upsertApplication({
        applywizz_id: appItem.applywizzId,
        job_url: appItem.jobUrl,
        company_name: appItem.companyName,
        job_title: appItem.jobTitle,
        status: status as any || 'READY_FOR_REVIEW',
        resolved_fields: resolvedFields as any,
        proof_web_url: proofWebUrl,
        dry_run_screenshot_url: dryRunScreenshotUrl,
        has_manual_edits: hasManualEdits,
      });
    } catch {}

    const finalId = persistedRow?.id || rowId;

    cacheApplicationLocally({
      ...toApplicationRow(appItem),
      id: finalId,
      resolved_fields: resolvedFields as any,
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
        options: ['select', 'radio', 'checkbox'].includes(f.type)
          ? Array.isArray(f.options)
            ? f.options
            : []
          : undefined,
      })),
    });
    return;
  }

  res.status(404).json({
    error: `Application not found for candidate '${applywizzId}' and job '${decodedUrl}'.`,
  });
});
