/**
 * Cooperative stop for long-running ingest / V1Pipeline runs (dev operator control).
 */

import config from '../config/env.js';

export class PipelineAbortedError extends Error {
  constructor(message = 'Pipeline stopped by operator') {
    super(message);
    this.name = 'PipelineAbortedError';
  }
}

let abortRequested = false;

/** True when POST /api/admin/stop-ingest (or SIGINT on CLI) is allowed. */
export function isPipelineStopEnabled(): boolean {
  return config.ENABLE_PIPELINE_STOP || config.NODE_ENV === 'development';
}

export function resetPipelineAbort(): void {
  abortRequested = false;
}

export function requestPipelineAbort(): void {
  abortRequested = true;
}

export function isPipelineAbortRequested(): boolean {
  return abortRequested;
}

export function throwIfPipelineAborted(phase?: string): void {
  if (!abortRequested) return;
  const suffix = phase ? ` (${phase})` : '';
  throw new PipelineAbortedError(`Pipeline stopped by operator${suffix}`);
}

export function isPipelineAbortedError(err: unknown): err is PipelineAbortedError {
  return err instanceof PipelineAbortedError || (err as Error)?.name === 'PipelineAbortedError';
}
