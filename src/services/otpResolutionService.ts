import { createLogger } from '../utils/logger.js';
import {
  getApplication,
  updateStatus,
  MAX_SUBMISSION_RETRIES,
} from '../db/applications.js';
import { getProfile } from '../db/profiles.js';
import { fetchZohoOtpViaApi, fetchGmailOtpViaApi } from './zoho-connector.js';
import { config } from '../config/env.js';
import { emitFailureDiagnostic, withDiagnosticRun } from '../utils/failureDiagnostics.js';
import { captureJobFailedScreenshot } from '../submitter/proofCapture.js';
import { OTP_CHALLENGE_TIMEOUT_MS, OTP_POLL_INTERVAL_MS } from '../submitter/otpTimeouts.js';

const log = createLogger('OTP Resolution');
export { OTP_CHALLENGE_TIMEOUT_MS } from '../submitter/otpTimeouts.js';
const TERMINAL_OTP_FETCH_REASONS = new Set([
  'INVALID_CANDIDATE_EMAIL',
  'INVALID_SUBMIT_TIMESTAMP',
  'STALE_TIMESTAMPS_ONLY',
]);

export interface OtpPendingEntry {
  applicationId: string;
  email: string;
  submitClickedAt: number;
  sessionKey: string;
  diagnosticRunId?: string;
  claimed: boolean;
  attemptedMessageIds: string[];
  attemptedCodes: string[];
  newestAttemptedTimestamp?: number;
}

const pendingEntries = new Map<string, OtpPendingEntry>();

export function getOtpFetchRetryTransition(currentRetryCount: number): {
  retryCount: number;
  status: 'QUEUED' | 'FAILED';
} {
  const safeRetryCount =
    Number.isInteger(currentRetryCount) && currentRetryCount >= 0 ? currentRetryCount : 0;
  if (safeRetryCount >= MAX_SUBMISSION_RETRIES) {
    return { retryCount: safeRetryCount, status: 'FAILED' };
  }

  const nextRetryCount = safeRetryCount + 1;
  if (nextRetryCount >= MAX_SUBMISSION_RETRIES) {
    return { retryCount: nextRetryCount, status: 'FAILED' };
  }
  return {
    retryCount: nextRetryCount,
    status: 'QUEUED',
  };
}

export function isTerminalOtpFetchFailure(reasonCode: string): boolean {
  return TERMINAL_OTP_FETCH_REASONS.has(reasonCode);
}

export function normalizeCompanyNameForOtp(companyName?: string | null): string {
  if (!companyName) return '';
  return companyName
    .replace(/\s*[\(\[].*?[\)\]]/g, '')
    .replace(/,?\s+(Inc\.?|Corp\.?|LLC\.?|Ltd\.?|Software|Robotics|Interactive|Corporation|Technologies|Solutions|Group|Holdings|Ventures)\b.*/i, '')
    .trim();
}

export function resolveOtpEndpoint(candidateEmail: string): 'zoho' | 'gmail' {
  const normalized = (candidateEmail || '').trim().toLowerCase();
  if (normalized.endsWith('@gmail.com') || normalized.endsWith('@googlemail.com')) {
    return 'gmail';
  }
  return 'zoho';
}

export interface OtpResolutionDeps {
  getApplication?: typeof getApplication;
  getProfile?: typeof getProfile;
  updateStatus?: typeof updateStatus;
  fetchZohoOtpViaApi?: typeof fetchZohoOtpViaApi;
  fetchGmailOtpViaApi?: typeof fetchGmailOtpViaApi;
  resolvePausedSession?: (id: string) => { session: any; canonicalKey: string } | null;
  submitOtpToPausedSession?: (sessionKey: string, otp: string, options?: any) => Promise<any>;
  clearPausedSession?: (id: string, options?: { captureFailureProof?: boolean }) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export class OtpResolutionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private deps: OtpResolutionDeps;

  constructor(customDeps?: OtpResolutionDeps) {
    this.deps = customDeps || {};
  }

  public register(
    entry: Omit<
      OtpPendingEntry,
      | 'claimed'
      | 'attemptedMessageIds'
      | 'attemptedCodes'
      | 'newestAttemptedTimestamp'
    >
  ): OtpPendingEntry {
    const fullEntry: OtpPendingEntry = {
      ...entry,
      claimed: false,
      attemptedMessageIds: (entry as any).attemptedMessageIds || [],
      attemptedCodes: (entry as any).attemptedCodes || [],
    };
    pendingEntries.set(entry.applicationId, fullEntry);
    log.info(
      `[OTP Resolution] event=resolver_registered application=${entry.applicationId} ` +
        `submit_clicked_at=${new Date(entry.submitClickedAt).toISOString()} ` +
        `budget_ms=${OTP_CHALLENGE_TIMEOUT_MS}`
    );
    return fullEntry;
  }

  public cancel(applicationId: string): void {
    pendingEntries.delete(applicationId);
  }

  public start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.processPending();
    }, config.OTP_RESOLUTION_POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.processPending();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async processPending(): Promise<void> {
    if (!this.running) return;
    const entries = Array.from(pendingEntries.values());
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.claimed) return;
        entry.claimed = true;
        await this.processEntry(entry).catch((error: unknown) => {
          const errorName = error instanceof Error ? error.name : 'UnknownError';
          const errorCode =
            error && typeof error === 'object' && 'code' in error
              ? String((error as { code?: unknown }).code || 'unknown')
              : 'unknown';
          log.error(
            `[OTP Resolution] event=resolver_unexpected_failure application=${entry.applicationId} ` +
              `error_name=${errorName} error_code=${errorCode}`
          );
          entry.claimed = false;
        });
      })
    );
  }

  public async processEntry(entry: OtpPendingEntry): Promise<void> {
    return withDiagnosticRun(entry.diagnosticRunId, () => this.processEntryInContext(entry));
  }

  public async processEntryInContext(entry: OtpPendingEntry): Promise<void> {
    const liveSubmit = await import('../submitter/liveSubmit.js');
    const getApp = this.deps.getApplication ?? getApplication;
    const getProf = this.deps.getProfile ?? getProfile;
    const updateStat = this.deps.updateStatus ?? updateStatus;
    const fetchZoho = this.deps.fetchZohoOtpViaApi ?? fetchZohoOtpViaApi;
    const fetchGmail = this.deps.fetchGmailOtpViaApi ?? fetchGmailOtpViaApi;
    const resolveSession = this.deps.resolvePausedSession ?? liveSubmit.resolvePausedSession;
    const submitOtpSession = this.deps.submitOtpToPausedSession ?? liveSubmit.submitOtpToPausedSession;
    const clearSession = this.deps.clearPausedSession ?? liveSubmit.clearPausedSession;
    const sleepFn = this.deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    const application = await getApp(entry.applicationId);
    if (!application) {
      log.error(`[OTP Resolution] application=${entry.applicationId} outcome=cancelled reason=application_not_found`);
      this.cancel(entry.applicationId);
      return;
    }

    const retryCount = Number(application.retry_count ?? 0);
    const attemptNumber = retryCount + 1;
    const deadline = entry.submitClickedAt + OTP_CHALLENGE_TIMEOUT_MS;
    const startedAt = Date.now();
    let lastReason = 'NO_MATCHING_OTP_EMAIL';
    const session = resolveSession(entry.sessionKey);

    if (!session) {
      const message = '[OTP_SESSION:UNAVAILABLE] Paused browser session expired before automatic verification.';
      await this.failPendingEntry(entry, application, retryCount, message, 'OTP_SESSION_UNAVAILABLE', undefined, updateStat, getApp);
      this.cancel(entry.applicationId);
      return;
    }

    // Wait 10s after OTP detection before first mailbox query
    const elapsedSinceDetect = Date.now() - entry.submitClickedAt;
    if (elapsedSinceDetect < OTP_POLL_INTERVAL_MS) {
      await sleepFn(OTP_POLL_INTERVAL_MS - elapsedSinceDetect);
    }

    log.info(
      `[OTP Resolution] event=resolver_started application=${entry.applicationId} candidate=${application.applywizz_id} ` +
      `attempt=${attemptNumber} retry_count=${retryCount}/${MAX_SUBMISSION_RETRIES} ` +
      `budget_ms=${OTP_CHALLENGE_TIMEOUT_MS} elapsed_from_submit_ms=${Date.now() - entry.submitClickedAt} ` +
      `remaining_budget_ms=${Math.max(0, deadline - Date.now())} attempted_messages=${entry.attemptedMessageIds.length} started`
    );

    let currentEndpoint: 'gmail' | 'zoho' = resolveOtpEndpoint(entry.email);
    const companyParam = normalizeCompanyNameForOtp(application.company_name) || undefined;

    while (Date.now() < deadline) {
      if (!pendingEntries.has(entry.applicationId)) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs < OTP_POLL_INTERVAL_MS) {
        lastReason = 'POLL_BUDGET_EXHAUSTED';
        break;
      }
      log.info(
        `[OTP Resolution] ⏳ ${entry.applicationId} elapsed=${Date.now() - entry.submitClickedAt}ms/` +
          `${OTP_CHALLENGE_TIMEOUT_MS}ms attempt=${attemptNumber}`
      );
      try {
        log.info(
          `[OTP Resolution] application=${entry.applicationId} email=${entry.email} [OTP] routing → ${currentEndpoint}`
        );
        const result = currentEndpoint === 'gmail'
          ? await fetchGmail({
              candidateEmail: entry.email,
              sinceTimestamp: entry.submitClickedAt,
              companyName: companyParam,
              correlationId: entry.applicationId,
              timeoutMs: Math.min(30000, remainingMs),
              pollIntervalMs: OTP_POLL_INTERVAL_MS,
              excludedCodes: entry.attemptedCodes,
            })
          : await fetchZoho({
              candidateEmail: entry.email,
              correlationId: entry.applicationId,
              sinceTimestamp: entry.submitClickedAt,
              companyName: companyParam,
              timeoutMs: Math.min(30000, remainingMs),
              pollIntervalMs: OTP_POLL_INTERVAL_MS,
              newerThanTimestamp: entry.newestAttemptedTimestamp,
              excludedMessageIds: entry.attemptedMessageIds,
              excludedCodes: entry.attemptedCodes,
            });

        if (!result.success || !result.otp || !result.messageId) {
          lastReason = result.reasonCode || 'NO_MATCHING_OTP_EMAIL';
          log.warn(
            `[OTP Resolution] event=otp_lookup_result application=${entry.applicationId} ` +
              `outcome=not_found reason=${lastReason} elapsed_from_submit_ms=${Date.now() - entry.submitClickedAt} ` +
              `lookup_elapsed_ms=${Date.now() - startedAt} remaining_budget_ms=${Math.max(0, deadline - Date.now())}`
          );

          if (isTerminalOtpFetchFailure(result.reasonCode || '')) {
            await emitFailureDiagnostic({
              category: 'SUBMIT_OTP_FETCH',
              stage: 'otp_mailbox_lookup',
              reason: 'Automatic OTP retrieval could not proceed because the mailbox lookup failed.',
              errorCode: result.reasonCode,
              isTerminal: true,
              isRetryable: false,
              applywizzId: application.applywizz_id,
              applicationId: entry.applicationId,
              jobUrl: application.job_url,
              metadata: { elapsedMs: Date.now() - startedAt, reasonCode: result.reasonCode || 'unknown' },
            });
            await clearSession(entry.sessionKey, { captureFailureProof: false });
            await this.failPendingEntry(
              entry,
              application,
              retryCount,
              `[OTP_FETCH:${lastReason}] Automatic OTP retrieval cannot proceed.`,
              lastReason,
              undefined,
              updateStat,
              getApp
            );
            this.cancel(entry.applicationId);
            return;
          }

          // not_yet / poll timeout: wait only when another full poll fits before the deadline.
          if (deadline - Date.now() >= OTP_POLL_INTERVAL_MS) {
            await sleepFn(OTP_POLL_INTERVAL_MS);
          } else {
            lastReason = 'POLL_BUDGET_EXHAUSTED';
            break;
          }
          continue;
        }

        if (!pendingEntries.has(entry.applicationId)) return;
        entry.attemptedMessageIds.push(result.messageId);
        entry.attemptedCodes.push(result.otp);
        if (result.receivedAtMs !== undefined) {
          entry.newestAttemptedTimestamp = Math.max(
            entry.newestAttemptedTimestamp ?? 0,
            result.receivedAtMs
          );
        }
        log.info(
          `[OTP Resolution] event=otp_code_received application=${entry.applicationId} ` +
            `message_id=${result.messageId} received_at=${result.receivedAt || 'unknown'} ` +
            `message_age_at_submit_ms=${result.receivedAtMs === undefined ? 'unknown' : result.receivedAtMs - entry.submitClickedAt} ` +
            `code_length=${result.otp.length} code=[REDACTED] elapsed_from_submit_ms=${Date.now() - entry.submitClickedAt}`
        );
        const submitResult = await submitOtpSession(entry.sessionKey, result.otp, {
          jobUrl: application.job_url,
        });
        log.info(
          `[OTP Resolution] event=otp_submission_result application=${entry.applicationId} ` +
            `status=${submitResult.status} success=${submitResult.success} ` +
            `elapsed_from_submit_ms=${Date.now() - entry.submitClickedAt}`
        );
        if (submitResult.status === 'APPLIED' || submitResult.status === 'EMAIL_PROOF_PENDING') {
          log.info(
            `[OTP Resolution] application=${entry.applicationId} outcome=success ` +
              `status=${submitResult.status} elapsed_ms=${Date.now() - startedAt}`
          );
          this.cancel(entry.applicationId);
          return;
        }
        await emitFailureDiagnostic({
          category: 'SUBMIT_OTP_SUBMISSION',
          stage: 'otp_browser_submission',
          reason: 'OTP verification did not complete the application submission.',
          errorCode: submitResult.status,
          isTerminal: true,
          isRetryable: false,
          applywizzId: application.applywizz_id,
          applicationId: entry.applicationId,
          jobUrl: application.job_url,
        });
        const message = `[OTP_SUBMISSION:UNVERIFIED] A fresh code was received but submission was not verified (${submitResult.status}).`;
        await clearSession(entry.sessionKey);
        await this.failPendingEntry(entry, application, retryCount, message, 'OTP_SUBMISSION_UNVERIFIED', undefined, updateStat, getApp);
        this.cancel(entry.applicationId);
        return;
      } catch (error: unknown) {
        if (!pendingEntries.has(entry.applicationId)) return;
        await emitFailureDiagnostic({
          category: 'SUBMIT_OTP_SUBMISSION',
          stage: 'otp_browser_submission',
          reason: 'A fresh OTP was retrieved, but browser verification failed.',
          error,
          isTerminal: false,
          isRetryable: true,
          applywizzId: application.applywizz_id,
          applicationId: entry.applicationId,
          jobUrl: application.job_url,
        });
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || 'unknown')
            : 'unknown';
        const message = `OTP browser submission error (${errorName}; code=${errorCode}).`;
        log.error(
          `[OTP Resolution] event=otp_submission_exception application=${entry.applicationId} ` +
            `error_name=${errorName} error_code=${errorCode} elapsed_from_submit_ms=${Date.now() - entry.submitClickedAt}`
        );
        await clearSession(entry.sessionKey);
        await this.failPendingEntry(
          entry,
          application,
          retryCount,
          `[OTP_SUBMISSION:ERROR] ${message}`,
          'OTP_SUBMISSION_ERROR',
          undefined,
          updateStat,
          getApp
        );
        this.cancel(entry.applicationId);
        return;
      }
    }

    if (!pendingEntries.has(entry.applicationId)) return;
    const page = (session as any)?.session?.page || (session as any)?.page;
    if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
      await captureJobFailedScreenshot(page, application, 'otp_timeout').catch(() => null);
    }
    await clearSession(entry.sessionKey, { captureFailureProof: false });
    if (isTerminalOtpFetchFailure(lastReason)) {
      const errorMessage =
        `[OTP_FETCH:${lastReason}] No fresh OTP with valid submit-time freshness data was available.`;
      await this.failPendingEntry(entry, application, retryCount, errorMessage, lastReason, undefined, updateStat, getApp);
      this.cancel(entry.applicationId);
      return;
    }

    const nextRetryCount = retryCount + 1;
    let isMailboxConnected = true;
    if (application.applywizz_id) {
      try {
        const profile = await getProf(application.applywizz_id);
        if (profile && profile.zoho_connected === false) {
          isMailboxConnected = false;
        }
      } catch (err: any) {
        log.warn(`[OTP Resolution] Could not verify mailbox connection for ${application.applywizz_id}: ${err.message}`);
      }
    }

    const isTerminal = nextRetryCount >= MAX_SUBMISSION_RETRIES || !isMailboxConnected;
    const finalStatus: 'FAILED' | 'QUEUED' = isTerminal ? 'FAILED' : 'QUEUED';
    const reasonDetail = !isMailboxConnected
      ? 'mailbox is disconnected (zoho_connected=false)'
      : `attempt ${nextRetryCount}/${MAX_SUBMISSION_RETRIES}`;
    const errorMessage =
      `[OTP_FETCH:TIMEOUT] OTP not received within ${OTP_CHALLENGE_TIMEOUT_MS / 1000}s ` +
      `(${reasonDetail}); reason=${lastReason}.`;

    await emitFailureDiagnostic({
      category: 'SUBMIT_OTP_TIMEOUT',
      stage: 'otp_mailbox_lookup',
      reason: !isMailboxConnected
        ? 'Automatic OTP retrieval exceeded deadline and candidate mailbox is not connected.'
        : 'Automatic OTP retrieval exceeded the configured submit-time deadline.',
      errorCode: lastReason,
      isTerminal,
      isRetryable: !isTerminal,
      applywizzId: application.applywizz_id,
      applicationId: entry.applicationId,
      jobUrl: application.job_url,
      metadata: {
        elapsedMs: Date.now() - entry.submitClickedAt,
        retryCount: nextRetryCount,
        reasonCode: lastReason,
        isMailboxConnected,
      },
    });

    try {
      await updateStat(entry.applicationId, finalStatus, {
        expected_status: 'OTP_REQUIRED',
        expected_retry_count: retryCount,
        error_message: errorMessage,
        retry_count: nextRetryCount,
        job_url: application.job_url,
      });
    } catch (statusError: unknown) {
      log.error(
        `[OTP Resolution] application=${entry.applicationId} outcome=status_update_failed ` +
          `reason=${statusError instanceof Error ? statusError.message : String(statusError)}`
      );
    }

    log.warn(
      `[OTP Resolution] application=${entry.applicationId} outcome=${finalStatus.toLowerCase()} ` +
        `reason=${lastReason} retry_count=${nextRetryCount}/${MAX_SUBMISSION_RETRIES} ` +
        `mailbox_connected=${isMailboxConnected} elapsed_ms=${Date.now() - startedAt} session=closed`
    );
    this.cancel(entry.applicationId);
  }

  private async failPendingEntry(
    entry: OtpPendingEntry,
    application: NonNullable<Awaited<ReturnType<typeof getApplication>>>,
    expectedRetryCount: number,
    errorMessage: string,
    reason: string,
    nextRetryCount?: number,
    updateStat: typeof updateStatus = updateStatus,
    getApp: typeof getApplication = getApplication
  ): Promise<void> {
    try {
      await updateStat(entry.applicationId, 'FAILED', {
        expected_status: 'OTP_REQUIRED',
        expected_retry_count: expectedRetryCount,
        error_message: errorMessage,
        retry_count: nextRetryCount,
        job_url: application.job_url,
      });
      log.error(
        `[OTP Resolution] application=${entry.applicationId} outcome=failed reason=${reason} ` +
          `retry_count=${nextRetryCount ?? expectedRetryCount}/${MAX_SUBMISSION_RETRIES}`
      );
    } catch (error: unknown) {
      const current = await getApp(entry.applicationId, application.job_url);
      if (
        current?.status !== 'OTP_REQUIRED' ||
        Number(current.retry_count ?? 0) !== expectedRetryCount
      ) {
        log.warn(
          `[OTP Resolution] application=${entry.applicationId} outcome=not_failed ` +
            `reason=status_changed current_status=${current?.status || 'missing'}`
        );
        return;
      }
      throw error;
    }
  }
}

export const otpResolutionService = new OtpResolutionService();
export default otpResolutionService;
