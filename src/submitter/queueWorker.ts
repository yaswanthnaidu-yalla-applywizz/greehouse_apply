/**
 * Round-robin queue daemon entrypoint.
 */

import { SubmitterPool } from './submitterPool.js';

export interface QueueDaemonOptions {
  concurrency?: number;
  pollIntervalMs?: number;
}

export class SubmissionQueueDaemon {
  private readonly pool: SubmitterPool;

  public constructor(options: QueueDaemonOptions = {}) {
    if (options.concurrency !== undefined && options.concurrency !== 3) {
      console.warn('[SubmissionQueueDaemon] Pool concurrency is fixed at 3 workers.');
    }
    this.pool = new SubmitterPool({ pollIntervalMs: options.pollIntervalMs });
  }

  public start(): void {
    this.pool.start();
  }

  public async stop(): Promise<void> {
    await this.pool.stop();
  }
}

export async function main(): Promise<void> {
  let interval = 2000;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--interval=')) {
      const value = Number.parseInt(arg.slice('--interval='.length), 10);
      if (!Number.isNaN(value)) interval = value;
    }
  }

  const daemon = new SubmissionQueueDaemon({ concurrency: 3, pollIntervalMs: interval });
  const handleShutdown = async (signal: string) => {
    process.stderr.write(`\n[SubmissionQueueDaemon] Received ${signal}. Stopping workers...\n`);
    await daemon.stop();
    process.exitCode = 0;
  };

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));
  daemon.start();
}

if (process.argv[1] && process.argv[1].includes('queueWorker')) {
  main().catch((error: Error) => {
    process.stderr.write(`[SubmissionQueueDaemon] Fatal error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
