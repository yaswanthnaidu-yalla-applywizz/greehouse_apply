/**
 * @fileoverview Round-Robin Background Submission Daemon (Phase V2-4c).
 *
 * Runs up to 3 concurrent Playwright workers (default 2) polling the global
 * submission queue via getNextQueuedApplicationForRoundRobin() and executing
 * automated submissions with live verification and proof capture.
 *
 * Usage:
 *   npx tsx src/submitter/queueWorker.ts [--workers=2] [--interval=2000]
 */

import { getNextQueuedApplicationForRoundRobin, updateStatus, type ApplicationRow } from '../db/applications.js';
import { runLiveSubmit } from './liveSubmit.js';
import { wsManager } from '../server/ws.js';

export interface QueueDaemonOptions {
  /** Number of concurrent submission workers (1-3, default 2) */
  concurrency?: number;
  /** Polling delay in milliseconds when queue is empty or after job completion (default 2000ms) */
  pollIntervalMs?: number;
}

export class SubmissionQueueDaemon {
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private isRunning: boolean = false;
  private activeWorkersCount: number = 0;
  private shutdownResolvers: Array<() => void> = [];

  constructor(options: QueueDaemonOptions = {}) {
    const requested = options.concurrency ?? 2;
    // Strictly clamp concurrency between 1 and 3
    this.concurrency = Math.min(3, Math.max(1, requested));
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  /**
   * Starts the worker pool and begins polling the queue.
   */
  public start(): void {
    if (this.isRunning) {
      process.stderr.write('[SubmissionQueueDaemon] ⚠️ Daemon is already running.\n');
      return;
    }

    this.isRunning = true;
    process.stderr.write(
      `[SubmissionQueueDaemon] 🚀 Started submission daemon with ${this.concurrency} concurrent workers (poll interval: ${this.pollIntervalMs}ms)\n`
    );

    for (let workerId = 1; workerId <= this.concurrency; workerId++) {
      this.spawnWorker(workerId);
    }
  }

  /**
   * Gracefully stops the queue daemon, letting in-flight submissions finish.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    process.stderr.write('[SubmissionQueueDaemon] 🛑 Stopping queue daemon (draining active workers)...\n');
    this.isRunning = false;

    if (this.activeWorkersCount > 0) {
      await new Promise<void>((resolve) => {
        this.shutdownResolvers.push(resolve);
      });
    }

    process.stderr.write('[SubmissionQueueDaemon] 🏁 All workers stopped successfully.\n');
  }

  /**
   * Worker loop polling the submission queue and submitting applications.
   */
  private async spawnWorker(workerId: number): Promise<void> {
    this.activeWorkersCount++;

    try {
      while (this.isRunning) {
        let app: ApplicationRow | null = null;

        try {
          app = await getNextQueuedApplicationForRoundRobin();
        } catch (fetchErr: any) {
          process.stderr.write(`[Worker ${workerId}] ⚠️ Error acquiring next queued application: ${fetchErr.message}\n`);
        }

        if (!app) {
          // Queue empty: sleep before next poll
          await this.sleep(this.pollIntervalMs);
          continue;
        }

        const appId = app.id || app.applywizz_id;
        console.log(
          `[Worker ${workerId}] 📥 Acquired application ${appId} (submission_order: ${app.submission_order ?? 'none'}, candidate: ${app.applywizz_id}, job: ${app.job_url})`
        );

        try {
          const result = await runLiveSubmit(appId, {
            headless: true,
            jobUrl: app.job_url,
          });

          console.log(
            `[Worker ${workerId}] ✅ Application ${appId} completed with status: ${result.status} (proof: ${result.proofWebUrl || 'none'})`
          );

          if (result.status === 'FAILED') {
            wsManager.emitApplicationFailed({
              appId,
              reason: result.errorMessage || 'Submission execution failed.',
              jobUrl: app.job_url,
              applywizzId: app.applywizz_id,
              companyName: app.company_name || undefined,
              jobTitle: app.job_title || undefined,
              proofFailedUrl: (result as any).proofFailedUrl || undefined,
            });
          }
        } catch (submitErr: any) {
          console.error(
            `[Worker ${workerId}] ❌ Submission failed for application ${appId}: ${submitErr.message}`
          );
          try {
            await updateStatus(appId, 'FAILED', {
              error_message: submitErr.message,
              job_url: app.job_url,
            });
          } catch {}

          wsManager.emitApplicationFailed({
            appId,
            reason: submitErr.message || 'Worker submission exception.',
            jobUrl: app.job_url,
            applywizzId: app.applywizz_id,
            companyName: app.company_name || undefined,
            jobTitle: app.job_title || undefined,
          });
        }

        // Sleep pollIntervalMs before looking for the next application
        await this.sleep(this.pollIntervalMs);
      }
    } finally {
      this.activeWorkersCount--;
      if (this.activeWorkersCount === 0) {
        for (const resolve of this.shutdownResolvers) {
          resolve();
        }
        this.shutdownResolvers = [];
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * CLI Runner for standalone daemon execution.
 */
export async function main(): Promise<void> {
  let workers = 2;
  let interval = 2000;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--workers=')) {
      const val = parseInt(arg.slice('--workers='.length), 10);
      if (!isNaN(val)) workers = val;
    } else if (arg.startsWith('--interval=')) {
      const val = parseInt(arg.slice('--interval='.length), 10);
      if (!isNaN(val)) interval = val;
    }
  }

  const daemon = new SubmissionQueueDaemon({
    concurrency: workers,
    pollIntervalMs: interval,
  });

  const handleShutdown = async (signal: string) => {
    process.stderr.write(`\n[SubmissionQueueDaemon] Received ${signal}. Initiating graceful shutdown...\n`);
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  daemon.start();
}

// Auto-run if executed directly via CLI (npx tsx src/submitter/queueWorker.ts)
if (process.argv[1] && process.argv[1].includes('queueWorker')) {
  main().catch((err) => {
    process.stderr.write(`[SubmissionQueueDaemon] Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}
