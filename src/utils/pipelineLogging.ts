/**
 * Ingest / full-pipeline log density. Default is compact (one line per phase or candidate).
 * Set PIPELINE_VERBOSE=true for per-URL scan lines and per-field resolution telemetry.
 */
import config from '../config/env.js';

export function isPipelineVerboseLogging(): boolean {
  return config.PIPELINE_VERBOSE;
}

export function isPipelineCompactLogging(): boolean {
  return !isPipelineVerboseLogging();
}
