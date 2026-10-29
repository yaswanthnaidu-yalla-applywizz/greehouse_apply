/**
 * @fileoverview Queue Worker lifecycle handler for submission results (Phase 5 Task 10).
 */

import type { ApplicationRow, ApplicationStatus, LiveSubmitResult } from '../db/applications/types.js';
import { logQueueStatusChange } from '../db/applications/queue.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('QueueWorker');

export interface WorkerSubmissionContext {
  updateStatusFn?: (id: string, status: ApplicationStatus, extra?: any) => Promise<any>;
  logStatusChangeFn?: (id: string, from: ApplicationStatus, to: ApplicationStatus) => Promise<any>;
}

export interface WorkerSubmissionHandlingOutcome {
  status: ApplicationStatus;
  updated: boolean;
  action: 'PROMOTED_APPLIED' | 'RETAINED_EMAIL_PROOF_PENDING' | 'ROUTED_OTP' | 'FAILED' | 'QUEUED';
}

/**
 * Handles the terminal outcome of a submission attempt in the queue worker lane.
 * Ensures that Ashby submissions returning 'EMAIL_PROOF_PENDING' or 'APPLIED'
 * are handled seamlessly without contradictory status overwrites.
 */
export async function handleWorkerSubmissionResult(
  result: LiveSubmitResult,
  application: ApplicationRow,
  context?: WorkerSubmissionContext
): Promise<WorkerSubmissionHandlingOutcome> {
  const applicationId = application.id || application.applywizz_id;
  const status = result.status;

  if (status === 'APPLIED') {
    const proofTag = result.hasEmailProof ? '[email proof captured]' : '[web proof captured]';
    log.info(`[Worker] ✅ Terminal Status → SUCCESS ${proofTag} (app-${applicationId})`);

    const logChange = context?.logStatusChangeFn || logQueueStatusChange;
    try {
      await logChange(applicationId, 'APPLYING', 'APPLIED');
    } catch {
      // Non-critical logging failure
    }

    return {
      status: 'APPLIED',
      updated: false, // Already set to APPLIED by submitter
      action: 'PROMOTED_APPLIED',
    };
  }

  if (status === 'EMAIL_PROOF_PENDING') {
    log.info(
      `[Worker] ⏳ Status → EMAIL_PROOF_PENDING [web proof captured] (app-${applicationId}, awaiting background confirmation)`
    );
    // Explicitly preserve EMAIL_PROOF_PENDING; do not overwrite with FAILED, QUEUED, or APPLIED.
    return {
      status: 'EMAIL_PROOF_PENDING',
      updated: false, // Preserved without contradictory overwrite
      action: 'RETAINED_EMAIL_PROOF_PENDING',
    };
  }

  if (status === 'OTP_REQUIRED') {
    log.info(`[Worker] 🔢 Status → OTP_REQUIRED (app-${applicationId})`);
    return {
      status: 'OTP_REQUIRED',
      updated: false,
      action: 'ROUTED_OTP',
    };
  }

  if (status === 'QUEUED') {
    const logChange = context?.logStatusChangeFn || logQueueStatusChange;
    try {
      await logChange(applicationId, 'APPLYING', 'QUEUED');
    } catch {}
    return {
      status: 'QUEUED',
      updated: false,
      action: 'QUEUED',
    };
  }

  // FAILED
  return {
    status: 'FAILED',
    updated: true,
    action: 'FAILED',
  };
}

export { SubmitterPool } from '../submitter/submitterPool.js';
export { SubmissionQueueDaemon, main } from '../submitter/queueWorker.js';
