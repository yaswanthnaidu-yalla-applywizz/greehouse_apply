/**
 * Fixed three-worker submission pool.
 *
 * Queue acquisition remains centralized so applications are assigned in the
 * order returned by the queue daemon. Each worker processes its own lane
 * serially while the three lanes run concurrently.
 */

import {
  getNextQueuedApplicationForRoundRobin,
  logQueueStatusChange,
  updateStatus,
  requeueApplicationForRetry,
  type ApplicationRow,
} from '../db/applications.js';
import { wsManager } from '../server/ws.js';
import { runLiveSubmit, type LiveSubmitResult } from './liveSubmit.js';
import { createLogger } from '../utils/logger.js';
import { getRetryReason } from './submissionRetry.js';
import {
  isEligibleForSubmission,
  SubmissionEligibilityBlockedError,
} from '../submission/submissionEligibilityGate.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';

const log = createLogger('Submitter Pool');

export interface SubmitterPoolOptions {
  pollIntervalMs?: number;
}

interface QueuedSubmission {
  application: ApplicationRow;
  resolve: (result: LiveSubmitResult) => void;
  reject: (error: Error) => void;
}

export class SubmitterPool {
  private readonly pollIntervalMs: number;
  private readonly poolSize: number;
  private readonly lanes: QueuedSubmission[][];
  private readonly inFlightApplicationIds = new Set<string>();
  private nextWorkerIndex = 0;
  private pendingAssignments = 0;
  private isRunning = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private signalHandlerAttached = false;

  constructor(options: SubmitterPoolOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    const poolSize = parseInt(process.env.SUBMISSION_POOL_SIZE ?? '3', 10);
    this.poolSize = Number.isInteger(poolSize) && poolSize > 0 ? poolSize : 3;
    this.lanes = Array.from({ length: this.poolSize }, () => []);
  }

  private async writeHeartbeat(statusOverride?: string): Promise<void> {
    if (!isSupabaseConfigured()) return;
    try {
      const snap = this.getSnapshot();
      const payload = {
        service_name: 'submitter_pool',
        status: statusOverride ?? (snap.running ? 'running' : 'stopped'),
        worker_count: snap.workerCount,
        idle_count: snap.idleCount,
        in_flight_count: snap.inFlightCount,
        in_flight_ids: snap.inFlightIds,
        lane_lengths: snap.laneLengths,
        updated_at: new Date().toISOString(),
      };
      await getDbClient()
        .from('system_worker_heartbeats')
        .upsert(payload, { onConflict: 'service_name' });
    } catch (err: any) {
      log.warn(`[Submitter Pool] Heartbeat write failed: ${err.message}`);
    }
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    for (let index = 0; index < this.poolSize; index += 1) {
      void this.runWorker(index);
    }
    void this.dispatchQueue();

    void this.writeHeartbeat('running');
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(() => {
      void this.writeHeartbeat();
    }, 5000);
    this.heartbeatInterval.unref?.();

    if (!this.signalHandlerAttached) {
      this.signalHandlerAttached = true;
      const onSignal = async () => {
        try {
          await this.stop();
        } catch {}
      };
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
    }
  }

  public async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.isRunning = false;
    await this.writeHeartbeat('stopped');
  }

  public getSnapshot(): {
    running: boolean;
    workerCount: number;
    idleCount: number;
    pendingAssignments: number;
    inFlightCount: number;
    inFlightIds: string[];
    laneLengths: number[];
  } {
    return {
      running: this.isRunning,
      workerCount: this.poolSize,
      idleCount: this.getIdleCount(),
      pendingAssignments: this.pendingAssignments,
      inFlightCount: this.inFlightApplicationIds.size,
      inFlightIds: Array.from(this.inFlightApplicationIds),
      laneLengths: this.lanes.map((lane) => lane.length),
    };
  }

  public async enqueue(application: ApplicationRow): Promise<LiveSubmitResult> {
    const workerIndex = this.nextWorkerIndex;
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.poolSize;
    this.pendingAssignments += 1;
    const appRef = application.id || application.applywizz_id;
    log.info(
      `[Submitter] Worker ${workerIndex + 1} assigned app-${appRef} | ${this.getIdleCount()} idle.`
    );

    return new Promise<LiveSubmitResult>((resolve, reject) => {
      this.lanes[workerIndex].push({ application, resolve, reject });
    });
  }

  private async dispatchQueue(): Promise<void> {
    while (this.isRunning) {
      try {
        const application = await getNextQueuedApplicationForRoundRobin();
        if (application) {
          const appRef = application.id || application.applywizz_id;
          if (this.inFlightApplicationIds.has(appRef)) {
            log.warn(
              `[Queue] Skipping app-${appRef} — already in flight on another worker (duplicate dequeue).`
            );
          } else {
            log.info(`[Queue] Dequeued app-${appRef} for submitter pool`);
            this.inFlightApplicationIds.add(appRef);
            void this.enqueue(application).catch((error: Error) => {
              log.error(`[Submitter] Queue assignment failed: ${error.message}`);
            });
          }
          continue;
        }
      } catch (error) {
        log.error(`[Submitter] Queue acquisition failed: ${(error as Error).message}`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async runWorker(workerIndex: number): Promise<void> {
    const workerNumber = workerIndex + 1;
    while (this.isRunning || this.lanes[workerIndex].length > 0) {
      const work = this.lanes[workerIndex].shift();
      if (!work) {
        await this.sleep(50);
        continue;
      }

      const { application } = work;
      const applicationId = application.id || application.applywizz_id;
      try {
        const eligibility = isEligibleForSubmission(application);
        if (!eligibility.eligible) {
          const message = eligibility.reason || 'Submission gate blocked this application.';
          log.warn(
            `[Gate TRACE] application=${applicationId} blocked=true score=${application.csv_job_score ?? 'missing'} ` +
              `field_count=${application.field_count ?? 'missing'} reason="${message}"`
          );
          await updateStatus(applicationId, 'READY_FOR_REVIEW', {
            error_message: message,
            job_url: application.job_url,
          });
          work.reject(new SubmissionEligibilityBlockedError(message));
          continue;
        }
        log.info(
          `[Gate TRACE] application=${applicationId} blocked=false score=${application.csv_job_score ?? 'missing'} ` +
            `field_count=${application.field_count ?? 'missing'}`
        );

        await updateStatus(applicationId, 'APPLYING', {
          job_url: application.job_url,
        });
        log.info(`[Submitter] Worker ${workerNumber} submitting app-${applicationId} → status=APPLYING`);
        log.info(`[API] Status → APPLYING (application ${applicationId}, submitter executing)`);
        await logQueueStatusChange(applicationId, 'QUEUED', 'APPLYING');

        const result = await runLiveSubmit(applicationId, {
          headless: true,
          jobUrl: application.job_url,
        });
        work.resolve(result);
        if (result.status === 'APPLIED') {
          log.info(`[API] Status → APPLIED (application ${applicationId})`);
          await logQueueStatusChange(applicationId, 'APPLYING', 'APPLIED');
        } else if (result.status === 'OTP_REQUIRED') {
          log.info(
            `[OTP] handed to resolution service (application ${applicationId})`
          );
        } else if (result.status === 'FAILED') {
          const reason = getRetryReason(result);
          if (reason) {
            const retry = await requeueApplicationForRetry(applicationId, reason, application.job_url);
            if (retry.requeued) {
              await logQueueStatusChange(applicationId, 'APPLYING', 'RETRY');
            } else {
              await logQueueStatusChange(applicationId, 'APPLYING', 'FAILED');
              this.emitFailure(application, result.errorMessage || reason, result);
            }
          } else {
            await logQueueStatusChange(applicationId, 'APPLYING', 'FAILED');
            this.emitFailure(application, result.errorMessage || 'Submission execution failed.', result);
          }
        } else if (result.status === 'QUEUED') {
          await logQueueStatusChange(applicationId, 'APPLYING', 'QUEUED');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = getRetryReason(error instanceof Error ? error : message);
        if (reason) {
          const retry = await requeueApplicationForRetry(applicationId, reason, application.job_url);
          if (retry.requeued) {
            await logQueueStatusChange(applicationId, 'APPLYING', 'QUEUED');
          } else {
            await updateStatus(applicationId, 'FAILED', {
              error_message: message,
              job_url: application.job_url,
            });
            await logQueueStatusChange(applicationId, 'APPLYING', 'FAILED');
            this.emitFailure(application, message);
          }
        } else {
          try {
            await updateStatus(applicationId, 'FAILED', {
              error_message: message,
              job_url: application.job_url,
            });
          } catch (statusError) {
            log.error(`[Submitter] Worker ${workerNumber} status update failed: ${(statusError as Error).message}`);
          }
          await logQueueStatusChange(applicationId, 'APPLYING', 'FAILED');
          this.emitFailure(application, message);
        }
        work.reject(error instanceof Error ? error : new Error(message));
      } finally {
        this.inFlightApplicationIds.delete(applicationId);
        this.pendingAssignments -= 1;
        log.info(`[Submitter] Worker ${workerNumber} released ${applicationId} | ${this.getIdleCount()} idle.`);
      }
    }
  }

  private emitFailure(application: ApplicationRow, reason: string, result?: LiveSubmitResult): void {
    wsManager.emitApplicationFailed({
      appId: application.id || application.applywizz_id,
      reason,
      jobUrl: application.job_url,
      applywizzId: application.applywizz_id,
      companyName: application.company_name || undefined,
      jobTitle: application.job_title || undefined,
      proofFailedUrl: result?.proofFailedUrl,
    });
  }

  private getIdleCount(): number {
    return Math.max(0, this.poolSize - this.pendingAssignments);
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
