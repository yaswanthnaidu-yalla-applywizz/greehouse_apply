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
  recoverStaleApplyingApplications,
  requeueApplicationForRetry,
  updateStatus,
  type ApplicationRow,
} from '../db/applications.js';
import { wsManager } from '../server/ws.js';
import { runLiveSubmit, type LiveSubmitOptions, type LiveSubmitResult } from './liveSubmit.js';
import { createLogger } from '../utils/logger.js';
import {
  isWithinSubmissionQuestionLimit,
  QuestionLimitExceededError,
} from '../submission/questionLimit.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { config } from '../config/env.js';
import { browserManager } from './browserManager.js';
import { getRetryReason, isAutomaticRetryAllowed } from './submissionRetry.js';

const log = createLogger('Submitter Pool');

export interface SubmitterPoolOptions {
  pollIntervalMs?: number;
  dequeueFn?: () => Promise<ApplicationRow | null>;
  updateStatusFn?: (id: string, status: any, extra?: any) => Promise<boolean>;
  submitFn?: (applicationId: string, options: LiveSubmitOptions) => Promise<LiveSubmitResult>;
  requeueFn?: typeof requeueApplicationForRetry;
}

interface QueuedSubmission {
  application: ApplicationRow;
  resolve: (result: LiveSubmitResult) => void;
  reject: (error: Error) => void;
}

export class SubmitterPool {
  private readonly pollIntervalMs: number;
  private readonly dequeueFn: () => Promise<ApplicationRow | null>;
  private readonly updateStatusFn: (id: string, status: any, extra?: any) => Promise<boolean>;
  private readonly submitFn: (applicationId: string, options: LiveSubmitOptions) => Promise<LiveSubmitResult>;
  private readonly requeueFn: typeof requeueApplicationForRetry;
  private readonly poolSize: number;
  private readonly lanes: QueuedSubmission[][];
  private readonly workerBusy: boolean[];
  private readonly inFlightApplicationIds = new Set<string>();
  private nextWorkerIndex = 0;
  private pendingAssignments = 0;
  private isRunning = false;
  private isStopping = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private signalHandlerAttached = false;

  constructor(options: SubmitterPoolOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.dequeueFn = options.dequeueFn ?? getNextQueuedApplicationForRoundRobin;
    this.updateStatusFn = options.updateStatusFn ?? updateStatus;
    this.submitFn = options.submitFn ?? runLiveSubmit;
    this.requeueFn = options.requeueFn ?? requeueApplicationForRetry;
    const poolSize = parseInt(config.SUBMISSION_POOL_SIZE ?? '3', 10);
    this.poolSize = Number.isInteger(poolSize) && poolSize > 0 ? Math.min(poolSize, 6) : 3;
    this.lanes = Array.from({ length: this.poolSize }, () => []);
    this.workerBusy = Array.from({ length: this.poolSize }, () => false);
  }

  private async writeHeartbeat(statusOverride?: string): Promise<void> {
    if (!isSupabaseConfigured()) return;
    try {
      const snap = this.getSnapshot();
      const browserStats = browserManager.getStats();
      const payload = {
        service_name: 'submitter_pool',
        status: statusOverride ?? (snap.running ? 'running' : 'stopped'),
        worker_count: snap.workerCount,
        idle_count: snap.idleCount,
        in_flight_count: snap.inFlightCount,
        in_flight_ids: snap.inFlightIds,
        lane_lengths: snap.laneLengths,
        browser_active_count: browserStats.activeCount,
        browser_waiting_count: browserStats.waitingCount,
        browser_max_count: browserStats.maxBrowsers,
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
      // Stagger worker start to avoid simultaneous Playwright launch spikes
      const delayMs = index * 1500;
      setTimeout(() => {
        if (this.isRunning) {
          void this.runWorker(index);
        }
      }, delayMs);
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
      const onSignal = async (sig: string) => {
        try {
          await this.handleShutdownSignal(sig);
        } catch {}
      };
      process.once('SIGTERM', () => void onSignal('SIGTERM'));
      process.once('SIGINT', () => void onSignal('SIGINT'));
    }
  }

  public async handleShutdownSignal(signal: string): Promise<void> {
    log.info(`[Pool] Received ${signal}. Executing shutdown recovery...`);
    await this.stop();
  }

  public async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.isStopping = true;
    this.isRunning = false;

    // Graceful shutdown state recovery: revert in-flight applications to QUEUED
    if (this.inFlightApplicationIds.size > 0) {
      const idsToRevert = Array.from(this.inFlightApplicationIds);
      log.info(`[Pool] Shutting down: reverting ${idsToRevert.length} in-flight applications to QUEUED...`);
      for (const id of idsToRevert) {
        try {
          if (this.updateStatusFn !== updateStatus) {
            await this.updateStatusFn(id, 'QUEUED');
            log.info(`[Pool] Reverted ${id} APPLYING → QUEUED on shutdown via updateStatusFn`);
          } else if (isSupabaseConfigured()) {
            const client = getDbClient();
            const { error } = await client
              .from('gh_candidate_applications')
              .update({
                status: 'QUEUED',
                updated_at: new Date().toISOString(),
              })
              .eq('id', id)
              .eq('status', 'APPLYING');

            if (!error) {
              log.info(`[Pool] Reverted ${id} APPLYING → QUEUED on shutdown`);
            } else {
              await this.updateStatusFn(id, 'QUEUED');
              log.info(`[Pool] Reverted ${id} APPLYING → QUEUED on shutdown via updateStatusFn`);
            }
          } else {
            await this.updateStatusFn(id, 'QUEUED');
            log.info(`[Pool] Reverted ${id} APPLYING → QUEUED on shutdown via updateStatusFn`);
          }
          this.inFlightApplicationIds.delete(id);
        } catch (err: any) {
          log.warn(`[Pool] Error reverting ${id} on shutdown: ${err.message}`);
        }
      }
    }

    for (let i = 0; i < this.poolSize; i++) {
      this.lanes[i] = [];
      this.workerBusy[i] = false;
    }
    this.pendingAssignments = 0;
    this.isStopping = false;

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

  public getIdleWorkerIndices(): number[] {
    const idle: number[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      if (!this.workerBusy[i] && this.lanes[i].length === 0) {
        idle.push(i);
      }
    }
    return idle;
  }

  public getIdleCount(): number {
    return this.getIdleWorkerIndices().length;
  }

  public async enqueue(application: ApplicationRow): Promise<LiveSubmitResult> {
    const idleIndices = this.getIdleWorkerIndices();
    const workerIndex = idleIndices.length > 0 ? idleIndices[0] : (this.nextWorkerIndex++ % this.poolSize);
    const appRef = application.id || application.applywizz_id;
    this.inFlightApplicationIds.add(appRef);
    this.workerBusy[workerIndex] = true;
    this.pendingAssignments = this.inFlightApplicationIds.size;
    log.info(
      `[Submitter] Worker ${workerIndex + 1} assigned app-${appRef} | ${this.getIdleCount()} idle.`
    );

    return new Promise<LiveSubmitResult>((resolve, reject) => {
      this.lanes[workerIndex].push({ application, resolve, reject });
    });
  }

  public async dispatchOnce(): Promise<{ idleWorkers: number; dequeued: number; inFlight: number }> {
    try {
      await recoverStaleApplyingApplications();
    } catch {}

    const idleWorkerIndices = this.getIdleWorkerIndices();
    const idleCount = idleWorkerIndices.length;
    let dequeuedCount = 0;

    if (idleCount > 0) {
      for (const workerIndex of idleWorkerIndices) {
        if (this.isStopping) break;

        const application = await this.dequeueFn();
        if (!application) {
          break; // No more QUEUED applications in database
        }

        const appRef = application.id || application.applywizz_id;
        if (this.inFlightApplicationIds.has(appRef)) {
          log.warn(
            `[Queue] Skipping app-${appRef} — already in flight on another worker (duplicate dequeue).`
          );
          continue;
        }

        dequeuedCount += 1;
        this.inFlightApplicationIds.add(appRef);
        this.workerBusy[workerIndex] = true;
        this.pendingAssignments = this.inFlightApplicationIds.size;

        log.info(
          `[Submitter] Worker ${workerIndex + 1} assigned app-${appRef} | ${this.getIdleCount()} idle.`
        );

        this.lanes[workerIndex].push({
          application,
          resolve: () => {},
          reject: () => {},
        });
      }
    }

    log.info(
      `[Pool] dispatch: idleWorkers=${this.getIdleCount()} dequeued=${dequeuedCount} inFlight=${this.inFlightApplicationIds.size}`
    );

    return {
      idleWorkers: this.getIdleCount(),
      dequeued: dequeuedCount,
      inFlight: this.inFlightApplicationIds.size,
    };
  }

  private async dispatchQueue(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.dispatchOnce();
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
        this.workerBusy[workerIndex] = false;
        await this.sleep(50);
        continue;
      }

      this.workerBusy[workerIndex] = true;
      const { application } = work;
      const applicationId = application.id || application.applywizz_id;
      try {
        const eligibility = isWithinSubmissionQuestionLimit(application);
        if (!eligibility.eligible) {
          const message = eligibility.reason || 'Application exceeds the question limit.';
          log.warn(`[Submitter] application=${applicationId} blocked by question limit: ${message}`);
          await this.updateStatusFn(applicationId, 'READY_FOR_REVIEW', {
            error_message: message,
            job_url: application.job_url,
          });
          work.reject(new QuestionLimitExceededError(message));
          continue;
        }

        await this.updateStatusFn(applicationId, 'APPLYING', {
          job_url: application.job_url,
        });
        log.info(`[Submitter] Worker ${workerNumber} submitting app-${applicationId} → status=APPLYING`);
        log.info(`[API] Status → APPLYING (application ${applicationId}, submitter executing)`);
        await logQueueStatusChange(applicationId, 'QUEUED', 'APPLYING');

        const result = await this.submitFn(applicationId, {
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
          const failureMessage = result.errorMessage || 'Submission execution failed.';
          const retryReason = getRetryReason(result);
          let finalStatus = 'FAILED';
          if (isAutomaticRetryAllowed(retryReason)) {
            const retryOutcome = await this.requeueFn(
              applicationId,
              failureMessage,
              retryReason,
              application.job_url
            );
            finalStatus = retryOutcome.requeued ? 'QUEUED' : 'FAILED';
          } else {
            await this.updateStatusFn(applicationId, 'FAILED', {
              error_message: failureMessage,
              job_url: application.job_url,
            });
          }
          await logQueueStatusChange(applicationId, 'APPLYING', finalStatus);
          this.emitFailure(application, failureMessage, result);
        } else if (result.status === 'QUEUED') {
          await logQueueStatusChange(applicationId, 'APPLYING', 'QUEUED');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let finalStatus = 'FAILED';
        const retryReason = getRetryReason(error instanceof Error ? error : String(error));
        if (isAutomaticRetryAllowed(retryReason)) {
          try {
            const retryOutcome = await this.requeueFn(
              applicationId,
              message,
              retryReason,
              application.job_url
            );
            finalStatus = retryOutcome.requeued ? 'QUEUED' : 'FAILED';
          } catch (statusError) {
            log.error(`[Submitter] Worker ${workerNumber} retry requeue failed: ${(statusError as Error).message}`);
            await this.updateStatusFn(applicationId, 'FAILED', {
              error_message: message,
              job_url: application.job_url,
            });
          }
        } else {
          await this.updateStatusFn(applicationId, 'FAILED', {
            error_message: message,
            job_url: application.job_url,
          });
        }
        await logQueueStatusChange(applicationId, 'APPLYING', finalStatus);
        this.emitFailure(application, message);
        work.reject(error instanceof Error ? error : new Error(message));
      } finally {
        this.inFlightApplicationIds.delete(applicationId);
        this.workerBusy[workerIndex] = false;
        this.pendingAssignments = this.inFlightApplicationIds.size;
        log.info(`[Submitter] Worker ${workerNumber} released ${applicationId} | ${this.getIdleCount()} idle.`);
      }
    }
    this.workerBusy[workerIndex] = false;
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

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
