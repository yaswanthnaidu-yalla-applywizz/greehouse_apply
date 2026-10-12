/**
 * @fileoverview Process Crash Guard and Stale Application Sweep (Phase 1).
 *
 * Protects the master Node.js daemon from terminating on Playwright CDP socket
 * disconnections, and sweeps orphaned in-flight applications on startup/shutdown.
 */

import { getDbClient } from '../db/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CrashGuard');

const PLAYWRIGHT_CDP_PATTERNS = [
  /unexpected end of json input/i,
  /target closed/i,
  /browser closed/i,
  /protocol error/i,
  /cdp socket/i,
  /connection closed/i,
];

/**
 * Checks whether an error is an expected Playwright / CDP disconnect error.
 */
export function isPlaywrightCdpError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? `${error.name} ${error.message} ${error.stack || ''}` : String(error);
  return PLAYWRIGHT_CDP_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Handles uncaught exceptions. Suppresses CDP disconnect crashes to keep
 * daemon alive; exits on non-CDP fatal errors.
 */
export function handleUncaughtException(
  error: unknown,
  exitFn: (code: number) => void = (code) => process.exit(code)
): void {
  if (isPlaywrightCdpError(error)) {
    log.warn(`[CrashGuard] Suppressed Playwright CDP disconnect error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const errorMsg = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
  log.error(`[CrashGuard] [HALT] Uncaught exception: ${errorMsg}`);
  exitFn(1);
}

/**
 * Handles unhandled promise rejections.
 */
export function handleUnhandledRejection(
  reason: unknown,
  _promise: Promise<unknown>,
  _exitFn: (code: number) => void = (code) => process.exit(code)
): void {
  if (isPlaywrightCdpError(reason)) {
    log.warn(`[CrashGuard] Suppressed Playwright CDP unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    return;
  }
  const errorMsg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  log.warn(`[CrashGuard] Unhandled promise rejection: ${errorMsg}`);
}

export interface StaleSweepDeps {
  fetchStale?: (cutoff: Date) => Promise<Array<{ id: string; status: string; updated_at: string }>>;
  updateStatus?: (ids: string[], newStatus: string) => Promise<void>;
}

/**
 * Sweeps stale in-flight applications (OTP_REQUIRED, APPLYING) that haven't been updated
 * in more than cutoffMs (default: 10 minutes) and resets them to QUEUED.
 */
export async function sweepStaleApplications(
  deps?: StaleSweepDeps,
  cutoffMs: number = 10 * 60 * 1000
): Promise<number> {
  const cutoff = new Date(Date.now() - cutoffMs);

  if (deps?.fetchStale && deps?.updateStatus) {
    const staleApps = await deps.fetchStale(cutoff);
    if (!staleApps || staleApps.length === 0) return 0;
    const ids = staleApps.map((a) => a.id);
    await deps.updateStatus(ids, 'QUEUED');
    log.info(`[CrashGuard] Recovered ${ids.length} stale applications back to QUEUED.`);
    return ids.length;
  }

  try {
    const supabase = getDbClient();
    const { data, error } = await supabase
      .from('candidate_applications')
      .select('id, status, updated_at')
      .in('status', ['OTP_REQUIRED', 'APPLYING'])
      .lt('updated_at', cutoff.toISOString());

    if (error) {
      log.error(`[CrashGuard] Failed to fetch stale applications: ${error.message}`);
      return 0;
    }

    if (!data || data.length === 0) {
      return 0;
    }

    const ids = data.map((row: { id: string }) => row.id);
    const { error: updateError } = await supabase
      .from('candidate_applications')
      .update({
        status: 'QUEUED',
        updated_at: new Date().toISOString(),
      })
      .in('id', ids);

    if (updateError) {
      log.error(`[CrashGuard] Failed to update stale applications: ${updateError.message}`);
      return 0;
    }

    log.info(`[CrashGuard] Recovered ${ids.length} stale applications (OTP_REQUIRED/APPLYING >10m) back to QUEUED.`);
    return ids.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[CrashGuard] Stale application sweep error: ${msg}`);
    return 0;
  }
}

let isCrashGuardInstalled = false;

/**
 * Installs top-level process crash guards.
 */
export function setupProcessCrashGuard(): void {
  if (isCrashGuardInstalled) return;
  isCrashGuardInstalled = true;

  process.on('uncaughtException', (err) => handleUncaughtException(err));
  process.on('unhandledRejection', (reason, promise) => handleUnhandledRejection(reason, promise));

  log.info('[CrashGuard] Top-level crash guards installed.');
}
