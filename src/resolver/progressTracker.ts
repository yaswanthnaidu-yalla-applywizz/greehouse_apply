/**
 * @fileoverview Dual-mode progress tracker for Answer Resolution Engine.
 *
 * Supports:
 *  1. Interactive TTY terminals: in-place dual progress bars for Tiers 1-4 and Tier 5 batches.
 *  2. Headless/Railway cloud logs: clean, throttled single-line status heartbeats without ANSI escapes.
 */

import readline from 'node:readline';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Resolver Progress');

export interface Tier14ProgressState {
  completed: number;
  total: number;
  fieldsResolved: number;
  tier5Escaped: number;
  skipped: number;
  rateJobsPerSec?: number;
}

export interface Tier5BatchProgressState {
  stage: 'idle' | 'haiku' | 'sonnet' | 'retry' | 'gemini' | 'ollama';
  status: 'submitting' | 'polling' | 'completed' | 'errored';
  batchId?: string;
  totalItems: number;
  completedItems: number;
  acceptedCount: number;
  escalatedCount: number;
  failedCount: number;
  elapsedMs?: number;
  details?: string;
}

export interface ResolverProgressSnapshot {
  tier14: Tier14ProgressState;
  tier5: Tier5BatchProgressState;
}

export type ResolverProgressCallback = (snapshot: ResolverProgressSnapshot) => void;

function renderBar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export class ResolverProgressTracker {
  private readonly isInteractive: boolean;
  private readonly onProgress?: ResolverProgressCallback;
  private hasRenderedInteractive = false;
  private lastT14LoggedCount = -1;
  private lastT5LoggedStatus = '';
  private cleanupRegistered = false;

  private t14State: Tier14ProgressState = {
    completed: 0,
    total: 0,
    fieldsResolved: 0,
    tier5Escaped: 0,
    skipped: 0,
  };

  private t5State: Tier5BatchProgressState = {
    stage: 'idle',
    status: 'completed',
    totalItems: 0,
    completedItems: 0,
    acceptedCount: 0,
    escalatedCount: 0,
    failedCount: 0,
  };

  private t14StartedAt: number = Date.now();
  private t5StartedAt: number = Date.now();

  constructor(options?: {
    onProgress?: ResolverProgressCallback;
    forceInteractive?: boolean;
  }) {
    this.onProgress = options?.onProgress;
    this.isInteractive =
      options?.forceInteractive ??
      Boolean(
        process.stdout.isTTY &&
          !process.env.RAILWAY_ENV &&
          !process.env.CI &&
          process.env.TERM !== 'dumb'
      );

    if (this.isInteractive && !this.cleanupRegistered) {
      this.cleanupRegistered = true;
      const restoreCursor = () => {
        try {
          process.stdout.write('\x1b[?25h\n');
        } catch {
          /* ignore */
        }
      };
      process.once('exit', restoreCursor);
      process.once('SIGINT', () => {
        restoreCursor();
        process.exit(130);
      });
    }
  }

  /**
   * Starts tracking Tier 1-4 deterministic waterfall.
   */
  public startTier14(totalJobs: number): void {
    this.t14StartedAt = Date.now();
    this.t14State = {
      completed: 0,
      total: Math.max(0, totalJobs),
      fieldsResolved: 0,
      tier5Escaped: 0,
      skipped: 0,
      rateJobsPerSec: 0,
    };
    this.lastT14LoggedCount = -1;

    if (!this.isInteractive) {
      log.info(`[T1-4 Tracker] 🚀 Started resolution across ${totalJobs} job assignments...`);
    }
    this.render();
  }

  /**
   * Updates Tier 1-4 progress with completed job info.
   */
  public updateTier14(delta: {
    completedDelta?: number;
    fieldsResolvedDelta?: number;
    tier5EscapedDelta?: number;
    skippedDelta?: number;
  }): void {
    this.t14State.completed += delta.completedDelta ?? 1;
    this.t14State.fieldsResolved += delta.fieldsResolvedDelta ?? 0;
    this.t14State.tier5Escaped += delta.tier5EscapedDelta ?? 0;
    this.t14State.skipped += delta.skippedDelta ?? 0;

    const elapsedSec = Math.max(0.001, (Date.now() - this.t14StartedAt) / 1000);
    this.t14State.rateJobsPerSec = Math.round((this.t14State.completed / elapsedSec) * 10) / 10;

    this.render();
  }

  /**
   * Marks Tier 1-4 as completed.
   */
  public completeTier14(): void {
    const elapsedSec = Math.max(0.001, (Date.now() - this.t14StartedAt) / 1000);
    this.t14State.rateJobsPerSec = Math.round((this.t14State.completed / elapsedSec) * 10) / 10;

    if (this.isInteractive && this.hasRenderedInteractive) {
      this.render();
    } else {
      log.info(
        `[T1-4 Tracker] ✅ Completed: ${this.t14State.completed}/${this.t14State.total} jobs in ${elapsedSec.toFixed(1)}s ` +
          `(${this.t14State.rateJobsPerSec} jobs/s) | T1-4 Fields: ${this.t14State.fieldsResolved} | Queued for Tier 5: ${this.t14State.tier5Escaped}`
      );
    }
  }

  /**
   * Starts tracking Tier 5 batch processing stage.
   */
  public startTier5Stage(
    stage: Tier5BatchProgressState['stage'],
    totalItems: number,
    details?: string
  ): void {
    this.t5StartedAt = Date.now();
    this.t5State = {
      stage,
      status: 'submitting',
      totalItems,
      completedItems: 0,
      acceptedCount: 0,
      escalatedCount: 0,
      failedCount: 0,
      elapsedMs: 0,
      details,
    };
    this.lastT5LoggedStatus = '';

    if (!this.isInteractive) {
      log.info(`[Tier 5 Batches] 🚀 Stage [${stage.toUpperCase()}] started for ${totalItems} questions${details ? ` (${details})` : ''}...`);
    }
    this.render();
  }

  /**
   * Updates Tier 5 batch progress state.
   */
  public updateTier5Batch(update: Partial<Tier5BatchProgressState>): void {
    this.t5State = {
      ...this.t5State,
      ...update,
      elapsedMs: Date.now() - this.t5StartedAt,
    };
    this.render();
  }

  /**
   * Completes the entire resolution tracking session.
   */
  public finish(): void {
    if (this.isInteractive && this.hasRenderedInteractive) {
      process.stdout.write('\n\n');
    }
  }

  public getSnapshot(): ResolverProgressSnapshot {
    return {
      tier14: { ...this.t14State },
      tier5: { ...this.t5State },
    };
  }

  private render(): void {
    // Notify external callback if provided
    if (this.onProgress) {
      try {
        this.onProgress(this.getSnapshot());
      } catch {
        /* ignore callback errors */
      }
    }

    if (this.isInteractive) {
      this.renderInteractive();
    } else {
      this.renderNonInteractive();
    }
  }

  private renderInteractive(): void {
    const t14Pct = this.t14State.total > 0 ? this.t14State.completed / this.t14State.total : 0;
    const t14Bar = renderBar(t14Pct, 20);
    const t14PctStr = (t14Pct * 100).toFixed(1).padStart(5, ' ');
    const rateStr = this.t14State.rateJobsPerSec ? `${this.t14State.rateJobsPerSec} jobs/s` : 'calc...';

    const line1 =
      `[Tiers 1-4] [${t14Bar}] ${this.t14State.completed}/${this.t14State.total} (${t14PctStr}%) ` +
      `| Resolved: ${this.t14State.fieldsResolved} | T5 Escaped: ${this.t14State.tier5Escaped} | ${rateStr}`;

    let line2 = '';
    if (this.t5State.stage === 'idle') {
      line2 = `[Tier 5 Batches] [${renderBar(0, 20)}] (Waiting for Tiers 1-4 to finish)`;
    } else {
      const t5Pct = this.t5State.totalItems > 0 ? this.t5State.completedItems / this.t5State.totalItems : 0;
      const t5Bar = renderBar(t5Pct, 20);
      const t5PctStr = (t5Pct * 100).toFixed(1).padStart(5, ' ');
      const elapsedSec = Math.round((this.t5State.elapsedMs ?? 0) / 1000);
      const stageStr = this.t5State.stage.toUpperCase();
      const statusStr = this.t5State.status;
      const batchIdStr = this.t5State.batchId ? ` [${this.t5State.batchId}]` : '';

      line2 =
        `[Tier 5 Batches] [${t5Bar}] ${stageStr}${batchIdStr} (${t5PctStr}%) ` +
        `| ${this.t5State.completedItems}/${this.t5State.totalItems} | Status: ${statusStr} (${elapsedSec}s)`;
    }

    try {
      // Hide cursor
      process.stdout.write('\x1b[?25l');

      if (!this.hasRenderedInteractive) {
        process.stdout.write(`${line1}\n${line2}`);
        this.hasRenderedInteractive = true;
      } else {
        readline.cursorTo(process.stdout, 0);
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`${line1}\n`);
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(line2);
      }
    } catch {
      // Fallback if terminal escapes fail
      this.renderNonInteractive();
    }
  }

  private renderNonInteractive(): void {
    // Throttle Tier 1-4 logs to every 25 jobs or every 5%
    const total = this.t14State.total;
    const completed = this.t14State.completed;
    const step = Math.max(25, Math.floor(total * 0.05));

    if (
      completed === 0 ||
      completed === total ||
      completed - this.lastT14LoggedCount >= step
    ) {
      this.lastT14LoggedCount = completed;
      const pct = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';
      const rate = this.t14State.rateJobsPerSec ? ` (${this.t14State.rateJobsPerSec} jobs/s)` : '';
      log.info(
        `[T1-4 Progress] ${completed}/${total} jobs (${pct}%)${rate} ` +
          `| Fields resolved: ${this.t14State.fieldsResolved} | Escaped to T5: ${this.t14State.tier5Escaped}`
      );
    }

    // Tier 5 batch status changes
    if (this.t5State.stage !== 'idle') {
      const statusKey = `${this.t5State.stage}:${this.t5State.status}:${this.t5State.completedItems}:${this.t5State.batchId || ''}`;
      if (statusKey !== this.lastT5LoggedStatus) {
        this.lastT5LoggedStatus = statusKey;
        const elapsedSec = Math.round((this.t5State.elapsedMs ?? 0) / 1000);
        log.info(
          `[Tier 5 Batches] Stage: ${this.t5State.stage.toUpperCase()}${this.t5State.batchId ? ` (${this.t5State.batchId})` : ''} ` +
            `| Status: ${this.t5State.status} (${elapsedSec}s) ` +
            `| Items: ${this.t5State.completedItems}/${this.t5State.totalItems}` +
            (this.t5State.acceptedCount ? ` (Accepted: ${this.t5State.acceptedCount}, Escalated: ${this.t5State.escalatedCount})` : '')
        );
      }
    }
  }
}
