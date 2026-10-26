/**
 * @fileoverview Submission queue operations, round-robin dequeuing, and retry management.
 */

import { getDbClient, isSupabaseConfigured } from "../client.js";
import { insertApplicationEvent } from "../events.js";
import { createLogger } from "../../utils/logger.js";
import { OperatorErrors } from "../../operator/operatorErrorMessages.js";
import { assertApplywizzZohoConnected } from "../zohoConnected.js";
import type { AutomaticSubmissionRetryReason } from "../../submitter/submissionRetry.js";
import { cacheApplicationLocally, getApplication } from "./crud.js";
import { countApplicationsByStatus } from "./statsQueries.js";
import { memoryApplications } from "./memoryStore.js";
import type { ApplicationRow, ApplicationStatus } from "./types.js";

const log = createLogger("ApplicationsQueue");

export const MAX_SUBMISSION_RETRIES = 3;

export async function retryFailedApplication(
  application: ApplicationRow
): Promise<boolean> {
  const nextRetryCount = 0;
  const payload = {
    status: 'QUEUED' as const,
    retry_count: nextRetryCount,
    error_message: null,
    submission_order: nextRetryCount,
    updated_at: new Date().toISOString(),
  };
  let updated = false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase.from('gh_candidate_applications').update(payload);
      if (application.id) {
        query = query.eq('id', application.id);
      } else {
        query = query
          .eq('applywizz_id', application.applywizz_id)
          .eq('job_url', application.job_url);
      }
      const result = await query.eq('status', 'RETRY').select('id');
      updated = !result.error && Array.isArray(result.data) && result.data.length > 0;
      if (result.error) {
        log.warn(`[DB] Operator retry failed for ${application.id || application.applywizz_id}: ${result.error.message}`);
      }
    } catch (err: any) {
      log.warn(`[DB] Operator retry exception for ${application.id || application.applywizz_id}: ${err.message}`);
    }
  } else {
    updated = true;
  }

  if (!updated) return false;
  cacheApplicationLocally({ ...application, ...payload });
  return true;
}

export async function requeueApplicationForRetry(
  applicationId: string,
  reason: string,
  retryReason: AutomaticSubmissionRetryReason,
  jobUrl?: string
): Promise<{ requeued: boolean; retryCount: number }> {
  const app = await getApplication(applicationId, jobUrl);
  if (!app) return { requeued: false, retryCount: 0 };
  const storedRetryCount = Number(app.retry_count ?? 0);
  const currentRetryCount =
    Number.isInteger(storedRetryCount) && storedRetryCount >= 0 && storedRetryCount <= MAX_SUBMISSION_RETRIES
      ? storedRetryCount
      : 0;
  if (currentRetryCount >= MAX_SUBMISSION_RETRIES) {
    log.warn(
      `[Retry] application=${applicationId} requeue=false retry_count=${currentRetryCount}/${MAX_SUBMISSION_RETRIES} retry_reason=${retryReason} reason="${reason}"`
    );
    return { requeued: false, retryCount: currentRetryCount };
  }

  const nextRetryCount = currentRetryCount + 1;
  const isTerminal = nextRetryCount >= MAX_SUBMISSION_RETRIES;
  const nextStatus = isTerminal ? ('FAILED' as const) : ('QUEUED' as const);
  const payload = {
    status: nextStatus,
    retry_count: nextRetryCount,
    submission_order: nextRetryCount,
    error_message: reason,
    updated_at: new Date().toISOString(),
  };
  let updated = false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      let query = supabase.from('gh_candidate_applications').update(payload);
      if (app.id) {
        query = query.eq('id', app.id);
      } else {
        query = query.eq('applywizz_id', app.applywizz_id).eq('job_url', app.job_url);
      }
      const result = await query
        .in('status', ['FAILED', 'APPLYING', 'RETRY'])
        .eq('retry_count', storedRetryCount)
        .select('id');
      updated = !result.error && Array.isArray(result.data) && result.data.length > 0;
      if (result.error) log.warn(`[DB] Retry requeue failed for ${applicationId}: ${result.error.message}`);
    } catch (err: any) {
      log.warn(`[DB] Retry requeue exception for ${applicationId}: ${err.message}`);
    }
  } else {
    updated = true;
  }

  if (!updated) return { requeued: false, retryCount: currentRetryCount };
  cacheApplicationLocally({ ...app, ...payload });
  log.info(
    `[Retry] application=${applicationId} requeue=${!isTerminal} retry_count=${nextRetryCount}/${MAX_SUBMISSION_RETRIES} ` +
      `status=${nextStatus} retry_reason=${retryReason} reason="${reason}"`
  );
  return { requeued: !isTerminal, retryCount: nextRetryCount };
}


/**
 * Counts terminal submission outcomes (APPLIED / FAILED), deduped by candidate + job URL,
 * optionally filtered by IST calendar date and allowed candidate IDs.
 */

export async function recoverStaleApplyingApplications(
  staleAfterMs = 15 * 60 * 1000
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  if (!isSupabaseConfigured()) return 0;

  const { data, error } = await getDbClient()
    .from('gh_candidate_applications')
    .update({
      status: 'QUEUED',
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'APPLYING')
    .lt('updated_at', cutoff)
    .select('id');
  if (error) {
    log.error(
      `[Queue] Failed to recover stale APPLYING applications: ${error.message}. ` +
      'Apply src/db/migrations/026_retry_status_repair.sql in Supabase.'
    );
    return 0;
  }
  const recovered = data?.length || 0;
  if (recovered > 0) {
    log.warn(`[Queue] Recovered ${recovered} stale APPLYING application(s) to RETRY.`);
  }
  return recovered;
}

/**
 * Event-based queue status logger:
 * [Queue] Status change: <FROM> → <TO> (app-<id>) | <queued> total queued, <applying> applying
 */
export async function logQueueStatusChange(
  appRef: string,
  fromStatus: string,
  toStatus: string
): Promise<void> {
  const queuedCount = await countApplicationsByStatus('QUEUED');
  const applyingCount = await countApplicationsByStatus('APPLYING');
  log.info(
    `[Queue] Status change: ${fromStatus} → ${toStatus} (app-${appRef}) | ${queuedCount} total queued, ${applyingCount} applying`
  );
}

/**
 * Inserts or transitions an application into the global submission queue (Phase V2-4c).
 * Calculates submission_order = MAX(submission_order) + 1 across all active/submitted applications.
 */
export async function enqueueApplication(
  applicationIdOrApplywizzId: string,
  options: {
    assignedCaEmail?: string;
    jobUrl?: string;
    expectedStatus?: ApplicationStatus;
    expectedRetryCount?: number;
    retryCount?: number;
    errorMessage?: string;
  } = {}
): Promise<{ submissionOrder: number; application: ApplicationRow }> {
  const app = await getApplication(applicationIdOrApplywizzId, options.jobUrl);
  if (!app) {
    throw new Error(`Application '${applicationIdOrApplywizzId}' not found to queue.`);
  }

  // Submission question limit check removed

  const previousStatus = app.status || 'READY_FOR_REVIEW';
  if (options.expectedStatus && previousStatus !== options.expectedStatus) {
    throw new Error(
      `Application '${applicationIdOrApplywizzId}' is ${previousStatus}; expected ${options.expectedStatus} before queueing.`
    );
  }
  if (
    options.expectedRetryCount !== undefined &&
    Number(app.retry_count ?? 0) !== options.expectedRetryCount
  ) {
    throw new Error(`Application '${applicationIdOrApplywizzId}' retry counter changed before queueing.`);
  }
  if (previousStatus === 'RETRY') {
    throw new Error('Application is awaiting explicit operator retry and cannot be submitted again.');
  }

  // 1. Calculate next global submission_order
  let maxOrder = 0;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('submission_order')
        .in('status', ['QUEUED', 'APPLYING', 'APPLIED', 'FAILED', 'RETRY'])
        .not('submission_order', 'is', null)
        .order('submission_order', { ascending: false })
        .limit(1);

      if (!error && data && data.length > 0 && typeof data[0].submission_order === 'number') {
        maxOrder = data[0].submission_order;
      }
    } catch (err: any) {
      log.warn(`[DB] Error querying MAX(submission_order): ${err.message}`);
    }
  }

  // Memory fallback check for MAX order
  for (const a of memoryApplications.values()) {
    if (
      ['QUEUED', 'APPLYING', 'APPLIED', 'FAILED'].includes(a.status) &&
      typeof a.submission_order === 'number' &&
      a.submission_order > maxOrder
    ) {
      maxOrder = a.submission_order;
    }
  }

  const nextOrder = maxOrder + 1;
  const updatePayload: Partial<ApplicationRow> = {
    status: 'QUEUED',
    submission_order: nextOrder,
    assigned_ca_email: options.assignedCaEmail || app.assigned_ca_email || null,
    updated_at: new Date().toISOString(),
  };
  if (options.retryCount !== undefined) updatePayload.retry_count = options.retryCount;
  if (options.errorMessage !== undefined) updatePayload.error_message = options.errorMessage;

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(app.id || '');
      let query = supabase
        .from('gh_candidate_applications')
        .update(updatePayload);
      if (isUuid) {
        query = query.eq('id', app.id);
      } else {
        query = query.eq('applywizz_id', app.applywizz_id).eq('job_url', app.job_url);
      }
      if (options.expectedStatus) query = query.eq('status', options.expectedStatus);
      if (options.expectedRetryCount !== undefined) query = query.eq('retry_count', options.expectedRetryCount);
      const queueRes = await query.select('id');
      if (queueRes.error) {
        throw new Error(`enqueueApplication Supabase error: ${queueRes.error.message}`);
      }
      if (
        (options.expectedStatus || options.expectedRetryCount !== undefined) &&
        (!queueRes.data || queueRes.data.length === 0)
      ) {
        throw new Error(
          `Application '${applicationIdOrApplywizzId}' changed status before expected queue transition.`
        );
      }
      void insertApplicationEvent({
        applicationId: app.id || '',
        applywizzId: app.applywizz_id,
        jobUrl: app.job_url,
        fromStatus: previousStatus ?? null,
        toStatus: 'QUEUED',
        actorEmail: options.assignedCaEmail ?? null,
      });
    } catch (err: any) {
      log.warn(`[DB] Could not update application to QUEUED in Supabase: ${err.message}`);
      throw err;
    }
  }

  const updatedApp: ApplicationRow = {
    ...app,
    ...updatePayload,
  };

  cacheApplicationLocally(updatedApp);
  const resolvedId = updatedApp.id || applicationIdOrApplywizzId;
  log.info(`[API] Submit clicked → status = QUEUED (ready for queue daemon)`);
  log.info(`[API] Status → QUEUED (application ${resolvedId}, submission_order=${nextOrder})`);
  await logQueueStatusChange(resolvedId, previousStatus, 'QUEUED');
  if (process.env.ENABLE_QUEUE_WORKER !== 'true') {
    log.warn(
      `[Queue] ENABLE_QUEUE_WORKER is not "true" — app ${resolvedId} will remain QUEUED until a submission worker runs`
    );
  }
  return { submissionOrder: nextOrder, application: updatedApp };
}

/**
 * Selects the next application from an in-memory list using round-robin fairness across candidates (applywizz_id).
 * Groups by applywizz_id, ranks each candidate's queued applications by submission_order ASC,
 * and orders candidates by round rank (rank 1 first across all candidates, then rank 2, etc.),
 * tie-broken by submission_order ASC.
 */
export function selectNextRoundRobinAppInMemory(
  apps: ApplicationRow[],
  options: { allCandidateApps?: ApplicationRow[] } = {}
): ApplicationRow | null {
  const queued = apps.filter((a) => a.status === 'QUEUED');
  if (queued.length === 0) return null;

  // If a broader list of candidate apps is provided (or if apps includes in-flight/completed apps),
  // compute how many applications each candidate has already had processed/dequeued
  const candidateProcessedCounts = new Map<string, number>();
  const allApps = options.allCandidateApps || apps;
  for (const app of allApps) {
    if (app.status && app.status !== 'QUEUED') {
      const key = (app.applywizz_id || '').trim().toUpperCase();
      candidateProcessedCounts.set(key, (candidateProcessedCounts.get(key) || 0) + 1);
    }
  }

  // Group queued by applywizz_id
  const byCandidate = new Map<string, ApplicationRow[]>();
  for (const app of queued) {
    const key = (app.applywizz_id || '').trim().toUpperCase();
    if (!byCandidate.has(key)) {
      byCandidate.set(key, []);
    }
    byCandidate.get(key)!.push(app);
  }

  // Sort each candidate's applications by submission_order ASC (nulls last) then created_at
  for (const list of byCandidate.values()) {
    list.sort((a, b) => {
      const orderA = a.submission_order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.submission_order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeA - timeB;
    });
  }

  // Assign candidate rank based on prior processed count + position in queued list
  const ranked: Array<{ app: ApplicationRow; candidateRank: number; candidateBase: number; submissionOrder: number }> = [];
  for (const [candId, list] of byCandidate.entries()) {
    const priorCount = candidateProcessedCounts.get(candId) || 0;
    list.forEach((app, idx) => {
      ranked.push({
        app,
        candidateRank: priorCount + idx + 1,
        candidateBase: priorCount,
        submissionOrder: app.submission_order ?? Number.MAX_SAFE_INTEGER,
      });
    });
  }

  // Sort by candidateRank ASC (Round 1 for all candidates first, then Round 2, etc.),
  // tie-broken by overall submissionOrder ASC
  ranked.sort((a, b) => {
    if (a.candidateRank !== b.candidateRank) {
      return a.candidateRank - b.candidateRank;
    }
    return a.submissionOrder - b.submissionOrder;
  });

  return ranked.length > 0 ? ranked[0].app : null;
}

/**
 * Retrieves the next application in the global submission queue for round-robin processing (Phase V2-4c).
 * Uses atomic PostgreSQL FOR UPDATE SKIP LOCKED via RPC with fallback to query.
 * Transitions status to 'APPLYING'.
 */
export async function getNextQueuedApplicationForRoundRobin(): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    const supabase = getDbClient();

    // 1. Try atomic PostgreSQL RPC function first
    try {
      const { data, error } = await supabase.rpc('get_next_queued_application');
      if (!error && data && Array.isArray(data) && data.length > 0) {
        const selected = data[0] as ApplicationRow;
        cacheApplicationLocally(selected);
        void insertApplicationEvent({
          applicationId: selected.id || '',
          applywizzId: selected.applywizz_id,
          jobUrl: selected.job_url,
          fromStatus: 'QUEUED',
          toStatus: 'APPLYING',
          actorEmail: selected.assigned_ca_email ?? null,
        });
        const appRef = selected.id || selected.applywizz_id;
        log.info(`[API] Status → APPLYING (application ${appRef}, dequeued via RPC from QUEUED)`);
        return selected;
      }
    } catch (rpcErr: any) {
      // If RPC doesn't exist or errors, fall through to fallback query
    }

    // 2. Fallback query if RPC is not yet created in Supabase SQL editor
    try {
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('*')
        .eq('status', 'QUEUED')
        .order('submission_order', { ascending: true })
        .limit(50);

      if (!error && data && data.length > 0) {
        // Query candidate counts for candidates present in the queued set to compute accurate candidate round ranks
        const queuedCandidateIds = Array.from(new Set(data.map((d: any) => d.applywizz_id).filter(Boolean)));
        let activeHistory: ApplicationRow[] = [];
        if (queuedCandidateIds.length > 0) {
          const { data: histData } = await supabase
            .from('gh_candidate_applications')
            .select('applywizz_id, status')
            .in('applywizz_id', queuedCandidateIds)
            .in('status', ['APPLYING', 'APPLIED', 'FAILED', 'RETRY', 'EMAIL_PROOF_PENDING']);
          if (histData) activeHistory = histData as ApplicationRow[];
        }

        let remainingCandidates = [...(data as ApplicationRow[])];

        while (remainingCandidates.length > 0) {
          const candidateApp = selectNextRoundRobinAppInMemory(remainingCandidates, {
            allCandidateApps: [...activeHistory, ...remainingCandidates],
          });
          if (!candidateApp) break;

          const applywizzId = candidateApp.applywizz_id;
          const gate = await assertApplywizzZohoConnected(applywizzId, { allowAdminDemo: true });
          if (!gate.allowed) {
            log.warn(
              `[Queue] ⛔ Candidate ${applywizzId} is not Zoho connected. Setting application ${candidateApp.id} to READY_FOR_REVIEW.`
            );
            await supabase
              .from('gh_candidate_applications')
              .update({
                status: 'READY_FOR_REVIEW',
                error_message: gate.error || OperatorErrors.ZOHO_NOT_CONNECTED,
                updated_at: new Date().toISOString(),
              })
              .eq('id', candidateApp.id)
              .eq('status', 'QUEUED');

            remainingCandidates = remainingCandidates.filter((c) => c.id !== candidateApp.id);
            continue;
          }

          const updateRes = await supabase
            .from('gh_candidate_applications')
            .update({
              status: 'APPLYING',
              updated_at: new Date().toISOString(),
            })
            .eq('id', candidateApp.id)
            .eq('status', 'QUEUED')
            .select('id');

          if (!updateRes.data || updateRes.data.length === 0) {
            // another worker claimed it — continue to next candidate
            remainingCandidates = remainingCandidates.filter((c) => c.id !== candidateApp.id);
            continue;
          }

          if (!updateRes.error) {
            const applyingApp: ApplicationRow = {
              ...candidateApp,
              status: 'APPLYING',
              updated_at: new Date().toISOString(),
            };
            cacheApplicationLocally(applyingApp);
            void insertApplicationEvent({
              applicationId: applyingApp.id || '',
              applywizzId: applyingApp.applywizz_id,
              jobUrl: applyingApp.job_url,
              fromStatus: 'QUEUED',
              toStatus: 'APPLYING',
              actorEmail: applyingApp.assigned_ca_email ?? null,
            });
            const appRef = applyingApp.id || applyingApp.applywizz_id;
            log.info(`[API] Status → APPLYING (application ${appRef}, dequeued from QUEUED via round-robin query fallback)`);
            return applyingApp;
          }
        }
      }
    } catch (queryErr: any) {
      log.warn(`[DB] Fallback queue selection error: ${queryErr.message}`);
    }
  }

  // 3. In-memory queue selection fallback
  const allMem = Array.from(memoryApplications.values());
  const next = selectNextRoundRobinAppInMemory(allMem);

  if (next) {
    next.status = 'APPLYING';
    next.updated_at = new Date().toISOString();
    const appRef = next.id || next.applywizz_id;
    log.info(`[API] Status → APPLYING (application ${appRef}, dequeued from in-memory round-robin QUEUED)`);
    return next;
  }

  return null;
}


/**
 * Updates scheduled_not_before on all remaining QUEUED Ashby applications for a candidate,
 * enforcing a random 40 to 60 minute delay between applications.
 */
export async function setAshbyScheduledNotBefore(applywizzId: string): Promise<void> {
  const delayMinutes = 40 + Math.floor(Math.random() * 21); // 40-60 min
  const notBefore = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

  if (isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      await supabase
        .from('gh_candidate_applications')
        .update({ scheduled_not_before: notBefore, updated_at: new Date().toISOString() })
        .eq('applywizz_id', applywizzId)
        .eq('ats', 'ashby')
        .eq('status', 'QUEUED');

      log.info(`[Queue] Set Ashby scheduled_not_before to ${notBefore} (+${delayMinutes}m) for ${applywizzId}`);
    } catch (err: any) {
      log.warn(`[Queue] Failed to set Ashby scheduled_not_before for ${applywizzId}: ${err.message}`);
    }
  }

  for (const app of memoryApplications.values()) {
    if (app.applywizz_id === applywizzId && app.ats === 'ashby' && app.status === 'QUEUED') {
      app.scheduled_not_before = notBefore;
    }
  }
}

/**
 * Claims the next EMAIL_PROOF_PENDING application across multi-replica workers.
 * Uses atomic PostgreSQL FOR UPDATE SKIP LOCKED via RPC with fallback query.
 */
export async function claimNextEmailProofApplication(): Promise<ApplicationRow | null> {
  if (isSupabaseConfigured()) {
    const supabase = getDbClient();
    try {
      const { data, error } = await supabase.rpc('claim_next_email_proof_application');
      if (!error && data && Array.isArray(data) && data.length > 0) {
        const selected = data[0] as ApplicationRow;
        cacheApplicationLocally(selected);
        return selected;
      }
    } catch (rpcErr: any) {
      log.warn(`[Queue] claim_next_email_proof_application RPC error: ${rpcErr.message}`);
    }

    try {
      const { data, error } = await supabase
        .from('gh_candidate_applications')
        .select('*')
        .eq('status', 'EMAIL_PROOF_PENDING')
        .or('email_proof_status.is.null,email_proof_status.in.(pending,manual_review_needed,timed_out,queued_retry)')
        .order('email_proof_attempted_at', { ascending: true, nullsFirst: true })
        .order('submitted_at', { ascending: true })
        .limit(1);

      if (!error && data && data.length > 0) {
        const candidate = data[0] as ApplicationRow;
        const nowIso = new Date().toISOString();
        const { data: updated, error: updateErr } = await supabase
          .from('gh_candidate_applications')
          .update({
            email_proof_status: 'fetching',
            email_proof_attempted_at: nowIso,
            updated_at: nowIso,
          })
          .eq('id', candidate.id)
          .select('*')
          .maybeSingle();

        if (!updateErr && updated) {
          cacheApplicationLocally(updated as ApplicationRow);
          return updated as ApplicationRow;
        }
      }
    } catch (queryErr: any) {
      log.warn(`[Queue] Fallback claim query error: ${queryErr.message}`);
    }
  }

  // In-memory fallback
  for (const app of memoryApplications.values()) {
    if (
      app.status === 'EMAIL_PROOF_PENDING' &&
      (!app.email_proof_status ||
        ['pending', 'manual_review_needed', 'timed_out', 'queued_retry'].includes(app.email_proof_status))
    ) {
      app.email_proof_status = 'fetching';
      app.email_proof_attempted_at = new Date().toISOString();
      app.updated_at = new Date().toISOString();
      return app;
    }
  }

  return null;
}

