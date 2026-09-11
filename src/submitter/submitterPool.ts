/**
 * Fixed three-worker submission pool.
 *
 * Queue acquisition remains centralized so applications are assigned in the
 * order returned by the queue daemon. Each worker processes its own lane
 * serially while the three lanes run concurrently.
 */

import {
  getNextQueuedApplicationForRoundRobin,
  updateStatus,
  type ApplicationRow,
} from '../db/applications.js';
import { wsManager } from '../server/ws.js';
import { runLiveSubmit, type LiveSubmitResult } from './liveSubmit.js';

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
  private readonly lanes: Array<QueuedSubmission[]> = [[], [], []];
  private readonly lanePromises: Promise<void>[] = [];
  private isRunning = false;
  private dispatchPromise: Promise<void> | null = null;
  private nextWorkerIndex = 0;
  private pendingAssignments = 0;

  public constructor(options: SubmitterPoolOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  public start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    for (let workerIndex = 0; workerIndex < 3; workerIndex += 1) {
      this.lanePromises.push(this.runWorker(workerIndex));
    }
    this.dispatchPromise = this.dispatchQueue();
    console.log('[Submitter] Worker pool started with 3 concurrent workers.');
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.dispatchPromise) {
      await this.dispatchPromise;
    }
    await Promise.all(this.lanePromises);
    this.lanePromises.length = 0;
    this.dispatchPromise = null;
  }

  public async enqueue(application: ApplicationRow): Promise<LiveSubmitResult> {
    if (!this.isRunning) {
      throw new Error('Submitter pool is not running.');
    }

    const workerIndex = this.nextWorkerIndex;
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % 3;
    this.pendingAssignments += 1;
    console.log(
      `[Submitter] Worker ${workerIndex + 1} assigned ${application.applywizz_id} ${application.id || application.job_url} | ${this.getIdleCount()} idle.`
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
          void this.enqueue(application).catch((error: Error) => {
            console.error(`[Submitter] Queue assignment failed: ${error.message}`);
          });
          continue;
        }
      } catch (error) {
        console.error(`[Submitter] Queue acquisition failed: ${(error as Error).message}`);
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
        const result = await runLiveSubmit(applicationId, {
          headless: true,
          jobUrl: application.job_url,
        });
        work.resolve(result);
        if (result.status === 'FAILED') {
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
          console.error(`[Submitter] Worker ${workerNumber} status update failed: ${(statusError as Error).message}`);
        }
        this.emitFailure(application, message);
        work.reject(error instanceof Error ? error : new Error(message));
      } finally {
        this.pendingAssignments -= 1;
        console.log(`[Submitter] Worker ${workerNumber} released ${applicationId} | ${this.getIdleCount()} idle.`);
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
