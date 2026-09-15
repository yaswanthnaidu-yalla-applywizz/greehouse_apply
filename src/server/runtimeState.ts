/**
 * In-process runtime handles shared by dashboard health/status routes.
 */

import type { SubmissionQueueDaemon } from '../submitter/queueWorker.js';

export interface IngestRunState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  processedCount?: number;
  processedFile?: string;
  message?: string;
  error?: string;
}

let queueDaemon: SubmissionQueueDaemon | null = null;
let ingestRun: IngestRunState = { running: false };

export function registerQueueDaemon(daemon: SubmissionQueueDaemon | null): void {
  queueDaemon = daemon;
}

export function getQueueDaemon(): SubmissionQueueDaemon | null {
  return queueDaemon;
}

export function getIngestRun(): IngestRunState {
  return ingestRun;
}

export function setIngestRun(next: IngestRunState): void {
  ingestRun = next;
}
