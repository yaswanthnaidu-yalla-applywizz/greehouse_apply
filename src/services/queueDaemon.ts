import { listApplications, updateStatus, type ApplicationRow } from '../db/applications.js';
import { runLiveSubmit } from '../submitter/liveSubmit.js';

export interface QueueWorker {
  id: number;
  applications: ApplicationRow[];
}

export type QueueApplicationProcessor = (
  application: ApplicationRow,
  workerId: number
) => Promise<void>;

export interface QueueDaemonOptions {
  workerCount?: number;
  pollIntervalMs?: number;
  processApplication?: QueueApplicationProcessor;
}

/**
 * Standalone round-robin dispatcher (not wired in server/index.ts).
 * Production submit flow uses SubmissionQueueDaemon + status QUEUED via enqueueApplication.
 * This class polls the same QUEUED status for optional alternate deployments.
 */
export class QueueDaemon {
  private readonly workerCount: number;
  private readonly pollIntervalMs: number;
  private readonly processApplication?: QueueApplicationProcessor;
  private readonly assignedApplicationIds = new Set<string>();
  private activeWorkers = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: QueueDaemonOptions = {}) {
    this.workerCount = Math.max(1, Math.min(3, options.workerCount ?? 3));
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.processApplication = options.processApplication;
  }

  public async runOnce(): Promise<QueueWorker[]> {
    const applications = (await listApplications({ status: 'QUEUED' }))
      .filter((application) => !this.assignedApplicationIds.has(this.applicationKey(application)))
      .sort((a, b) => {
        const candidateOrder = a.applywizz_id.localeCompare(b.applywizz_id);
        if (candidateOrder !== 0) return candidateOrder;
        return this.createdAt(a) - this.createdAt(b);
      });

    const workers: QueueWorker[] = Array.from({ length: this.workerCount }, (_, index) => ({
      id: index + 1,
      applications: [],
    }));

    if (applications.length > 0) {
      console.log(
        `[Queue] Fetched ${applications.length} applications waiting for submission (status=QUEUED)`
      );
    }

    applications.forEach((application, index) => {
      const worker = workers[index % this.workerCount];
      worker.applications.push(application);
      this.assignedApplicationIds.add(this.applicationKey(application));
      const appRef = application.id || application.applywizz_id;
      console.log(`[Submitter] Worker ${worker.id} assigned app-${appRef}`);
    });

    this.activeWorkers = Math.min(
      this.workerCount,
      workers.filter((worker) => worker.applications.length > 0).length
    );
    console.log(`[Queue] ${this.activeWorkers} workers busy, ${this.workerCount - this.activeWorkers} idle.`);

    await Promise.all(
      workers.map(async (worker) => {
        if (worker.applications.length === 0) return;
        try {
          for (const application of worker.applications) {
            await this.process(application, worker.id);
          }
        } finally {
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
          console.log(
            `[Queue] Worker ${worker.id} released | ${this.activeWorkers} workers busy, ${this.workerCount - this.activeWorkers} idle.`
          );
        }
      })
    );

    return workers;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Queue] Failed to assign approved applications: ${message}`);
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }

  private applicationKey(application: ApplicationRow): string {
    return application.id || `${application.applywizz_id}::${application.job_url}`;
  }

  private async process(application: ApplicationRow, workerId: number): Promise<void> {
    try {
      if (this.processApplication) {
        await this.processApplication(application, workerId);
        return;
      }

      const result = await runLiveSubmit(application.id || application.applywizz_id, {
        headless: true,
        jobUrl: application.job_url,
      });

      if (result.status === 'APPLIED') {
        await updateStatus(application.id || application.applywizz_id, 'APPLIED', {
          proof_web_url: result.proofWebUrl || null,
          proof_captured_at: result.proofCapturedAt || null,
          job_url: application.job_url,
        });
      } else if (result.status === 'FAILED') {
        await updateStatus(application.id || application.applywizz_id, 'FAILED', {
          proof_failed_url: result.proofFailedUrl || null,
          proof_failed_captured_at: result.proofFailedCapturedAt || null,
          error_message: result.errorMessage || result.message || 'Submission failed.',
          job_url: application.job_url,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateStatus(application.id || application.applywizz_id, 'FAILED', {
        error_message: message,
        job_url: application.job_url,
      });
      console.error(
        `[Queue] Worker ${workerId} failed ${application.applywizz_id} ${application.id || application.job_url}: ${message}`
      );
    }
  }

  private createdAt(application: ApplicationRow): number {
    const timestamp = application.created_at ? Date.parse(application.created_at) : 0;
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }
}
