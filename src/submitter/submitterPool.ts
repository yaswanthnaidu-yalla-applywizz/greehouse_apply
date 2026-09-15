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
  type ApplicationRow,
} from '../db/applications.js';
import { wsManager } from '../server/ws.js';
import { runLiveSubmit, type LiveSubmitResult } from './liveSubmit.js';
import { createLogger } from '../utils/logger.js';

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
  private readonly lanes: QueuedSubmission[][] = [[], [], []];
  private readonly inFlightApplicationIds = new Set<string>();
  private nextWorkerIndex = 0;
  private pendingAssignments = 0;
  private isRunning = false;

  constructor(options: SubmitterPoolOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    for (let index = 0; index < 3; index += 1) {
      void this.runWorker(index);
    }
    void this.dispatchQueue();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
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
      workerCount: 3,
      idleCount: this.getIdleCount(),
      pendingAssignments: this.pendingAssignments,
      inFlightCount: this.inFlightApplicationIds.size,
      inFlightIds: Array.from(this.inFlightApplicationIds),
      laneLengths: this.lanes.map((lane) => lane.length),
    };
  }

  public async enqueue(application: ApplicationRow): Promise<LiveSubmitResult> {
    const workerIndex = this.nextWorkerIndex;
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % 3;
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
        } else if (result.status === 'FAILED') {
          await logQueueStatusChange(applicationId, 'APPLYING', 'FAILED');
          this.emitFailure(application, result.errorMessage || 'Submission execution failed.', result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
    return Math.max(0, 3 - this.pendingAssignments);
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
