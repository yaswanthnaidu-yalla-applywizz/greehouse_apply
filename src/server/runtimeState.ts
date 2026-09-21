/**
 * In-process runtime handles shared by dashboard health/status routes.
 */

import config from '../config/env.js';
import type { SubmissionQueueDaemon } from '../submitter/queueWorker.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';

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

let cachedGateEnabled: boolean | null = null;
let lastGateFetchTime = 0;
const GATE_TTL_MS = 15000;
let gateFetchInProgress: Promise<boolean> | null = null;

export async function refreshSubmissionEligibilityGateFromDb(): Promise<boolean> {
  if (gateFetchInProgress) return gateFetchInProgress;
  gateFetchInProgress = (async () => {
    try {
      if (isSupabaseConfigured()) {
        const { data, error } = await getDbClient()
          .from('system_config')
          .select('value')
          .eq('key', 'submission_eligibility_gate_enabled')
          .maybeSingle();
        if (!error && data && data.value !== undefined && data.value !== null) {
          const raw = data.value;
          cachedGateEnabled = typeof raw === 'boolean' ? raw : (raw === 'true' || raw === true);
          lastGateFetchTime = Date.now();
          return cachedGateEnabled;
        }
      }
    } catch {
      // Fall through on error
    } finally {
      gateFetchInProgress = null;
    }
    if (cachedGateEnabled === null) {
      cachedGateEnabled = config.SUBMISSION_ELIGIBILITY_GATE_ENABLED;
    }
    lastGateFetchTime = Date.now();
    return cachedGateEnabled;
  })();
  return gateFetchInProgress;
}

export function getSubmissionEligibilityGateEnabled(): boolean {
  const now = Date.now();
  if (cachedGateEnabled === null) {
    cachedGateEnabled = config.SUBMISSION_ELIGIBILITY_GATE_ENABLED;
    void refreshSubmissionEligibilityGateFromDb();
  } else if (now - lastGateFetchTime > GATE_TTL_MS) {
    void refreshSubmissionEligibilityGateFromDb();
  }
  return cachedGateEnabled;
}

export function setSubmissionEligibilityGateEnabled(enabled: boolean): void {
  cachedGateEnabled = enabled;
  lastGateFetchTime = Date.now();
  if (isSupabaseConfigured()) {
    void getDbClient()
      .from('system_config')
      .upsert({
        key: 'submission_eligibility_gate_enabled',
        value: enabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
  }
}

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
