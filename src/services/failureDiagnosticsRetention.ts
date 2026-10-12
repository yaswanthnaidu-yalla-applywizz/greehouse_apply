import {
  countExpiredFailureDiagnostics,
  deleteExpiredFailureDiagnostics,
  failureDiagnosticCutoff,
} from '../db/failureDiagnostics.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Failure Diagnostics Retention');
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cleanupStarted = false;

export async function cleanupExpiredFailureDiagnostics(options: { dryRun?: boolean } = {}): Promise<{
  cutoff: string;
  expiredCount: number;
  deletedCount: number;
}> {
  const cutoff = failureDiagnosticCutoff();
  const expiredCount = await countExpiredFailureDiagnostics(cutoff);
  if (options.dryRun) {
    return { cutoff, expiredCount, deletedCount: 0 };
  }
  const deletedCount = await deleteExpiredFailureDiagnostics(cutoff);
  log.info(
    `[Failure Diagnostics Retention] cleanup complete cutoff=${cutoff} expired=${expiredCount} deleted=${deletedCount}`
  );
  return { cutoff, expiredCount, deletedCount };
}

export function startFailureDiagnosticsRetention(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;

  const runCleanup = async (trigger: 'startup' | 'daily'): Promise<void> => {
    try {
      const result = await cleanupExpiredFailureDiagnostics();
      log.info(
        `[Failure Diagnostics Retention] ${trigger} cleanup complete cutoff=${result.cutoff} expired=${result.expiredCount} deleted=${result.deletedCount}`
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || 'unknown')
          : 'unknown';
      log.error(`[Failure Diagnostics Retention] ${trigger} cleanup failed error_name=${name} error_code=${code}`);
    }
  };

  void runCleanup('startup');
  const timer = setInterval(() => {
    void runCleanup('daily');
  }, CLEANUP_INTERVAL_MS);
  timer.unref();
}
