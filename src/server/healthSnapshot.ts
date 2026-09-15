/**
 * High-level health probes shared by Admin (traffic lights) and Dev (same probes, more detail).
 */

import { countApplicationsByStatus, listApplications } from '../db/applications.js';
import { isSupabaseConfigured, getDbClient } from '../db/client.js';
import { CSV_UPLOADS_BUCKET } from '../db/storage.js';
import { config } from '../config/env.js';
import { isAzureEmailConfigured } from '../services/azureEmail.js';
import { getIngestRun, getQueueDaemon } from './runtimeState.js';

export type ProbeStatus = 'ok' | 'error' | 'not_configured' | 'degraded';

export interface ServiceProbe {
  name: string;
  status: ProbeStatus;
  detail: string;
  responseMs?: number;
  lastError?: string;
}

async function pingUrl(url: string, timeoutMs = 5000): Promise<{ ok: boolean; status?: number; responseMs: number; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'ApplyWizz-Greenhouse-Automation/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status, responseMs: Date.now() - started };
  } catch (err: any) {
    return { ok: false, responseMs: Date.now() - started, error: err?.message || 'request failed' };
  }
}

/** ApplyWizz get-client-details without an id returns 400. That still means the host answered. */
function applywizzProbeStatus(ping: { status?: number; error?: string }): {
  status: ProbeStatus;
  detail: string;
} {
  const code = ping.status;
  if (typeof code === 'number' && code < 500) {
    if (code === 400) {
      return { status: 'ok', detail: 'HTTP 400 (reachable; get-client-details needs applywizz_id)' };
    }
    return { status: 'ok', detail: `HTTP ${code}` };
  }
  return { status: 'error', detail: ping.error || (code ? `HTTP ${code}` : 'request failed') };
}

export async function collectHealthSnapshot(): Promise<{
  generatedAt: string;
  probes: ServiceProbe[];
  queue: {
    queued: number;
    applying: number;
    failed: number;
    applied: number;
    otpRequired: number;
    emailProofPending: number;
    stuck: number;
  };
  workers: ReturnType<NonNullable<ReturnType<typeof getQueueDaemon>>['getSnapshot']> | {
    running: false;
    workerCount: number;
    idleCount: number;
    pendingAssignments: number;
    inFlightCount: number;
    inFlightIds: string[];
    laneLengths: number[];
    enabled: boolean;
  };
  ingest: ReturnType<typeof getIngestRun>;
}> {
  const probes: ServiceProbe[] = [];

  if (!isSupabaseConfigured()) {
    probes.push({ name: 'database', status: 'not_configured', detail: 'SUPABASE_URL / service key missing.' });
    probes.push({ name: 'storage', status: 'not_configured', detail: 'Supabase Storage not configured.' });
  } else {
    const dbStarted = Date.now();
    try {
      const { error } = await getDbClient().from('profiles').select('id').limit(1);
      probes.push({
        name: 'database',
        status: error ? 'error' : 'ok',
        detail: error ? error.message : 'profiles reachable',
        responseMs: Date.now() - dbStarted,
        lastError: error?.message,
      });
    } catch (err: any) {
      probes.push({
        name: 'database',
        status: 'error',
        detail: err?.message || 'database probe failed',
        responseMs: Date.now() - dbStarted,
        lastError: err?.message,
      });
    }

    const storageStarted = Date.now();
    try {
      const { error } = await getDbClient().storage.from(CSV_UPLOADS_BUCKET).list('', { limit: 1 });
      probes.push({
        name: 'storage',
        status: error ? 'error' : 'ok',
        detail: error ? error.message : `${CSV_UPLOADS_BUCKET} list ok`,
        responseMs: Date.now() - storageStarted,
        lastError: error?.message,
      });
    } catch (err: any) {
      probes.push({
        name: 'storage',
        status: 'error',
        detail: err?.message || 'storage probe failed',
        responseMs: Date.now() - storageStarted,
        lastError: err?.message,
      });
    }
  }

  probes.push({
    name: 'email_otp',
    status: isAzureEmailConfigured() ? 'ok' : 'not_configured',
    detail: isAzureEmailConfigured() ? 'Azure / M365 sender configured' : 'Azure email env vars missing',
  });

  const zohoUrl = (config.ZOHO_CONNECTOR_URL || '').trim();
  if (!zohoUrl) {
    probes.push({ name: 'zoho', status: 'not_configured', detail: 'ZOHO_CONNECTOR_URL missing' });
  } else {
    const zoho = await pingUrl(zohoUrl);
    probes.push({
      name: 'zoho',
      status: zoho.ok ? 'ok' : 'error',
      detail: zoho.ok ? `HTTP ${zoho.status}` : zoho.error || `HTTP ${zoho.status}`,
      responseMs: zoho.responseMs,
      lastError: zoho.error,
    });
  }

  try {
    const applywizzUrl = new URL(config.APPLYWIZZ_API_URL);
    applywizzUrl.search = '';
    const applywizz = await pingUrl(applywizzUrl.toString());
    const judged = applywizzProbeStatus(applywizz);
    probes.push({
      name: 'applywizz',
      status: judged.status,
      detail: judged.detail,
      responseMs: applywizz.responseMs,
      lastError: judged.status === 'error' ? applywizz.error : undefined,
    });
  } catch (err: any) {
    probes.push({
      name: 'applywizz',
      status: 'error',
      detail: err?.message || 'APPLYWIZZ_API_URL invalid',
      lastError: err?.message,
    });
  }

  const [queued, applying, failed, applied, otpRequired, emailProofPending] = await Promise.all([
    countApplicationsByStatus('QUEUED'),
    countApplicationsByStatus('APPLYING'),
    countApplicationsByStatus('FAILED'),
    countApplicationsByStatus('APPLIED'),
    countApplicationsByStatus('OTP_REQUIRED'),
    countApplicationsByStatus('EMAIL_PROOF_PENDING'),
  ]);

  const applyingRows = await listApplications({ status: 'APPLYING' });
  const stuckCutoff = Date.now() - 15 * 60 * 1000;
  const stuck = applyingRows.filter((row) => {
    const at = Date.parse(row.updated_at || row.created_at || '');
    return Number.isFinite(at) && at < stuckCutoff;
  }).length;

  const daemon = getQueueDaemon();
  const workers = daemon
    ? { ...daemon.getSnapshot(), enabled: process.env.ENABLE_QUEUE_WORKER === 'true' }
    : {
        running: false,
        workerCount: 0,
        idleCount: 0,
        pendingAssignments: 0,
        inFlightCount: 0,
        inFlightIds: [] as string[],
        laneLengths: [] as number[],
        enabled: process.env.ENABLE_QUEUE_WORKER === 'true',
      };

  probes.push({
    name: 'queue',
    status: workers.enabled ? (queued > 50 ? 'degraded' : 'ok') : 'not_configured',
    detail: workers.enabled ? `${queued} queued, ${applying} applying` : 'ENABLE_QUEUE_WORKER is not true',
  });
  probes.push({
    name: 'workers',
    status: workers.running ? 'ok' : workers.enabled ? 'error' : 'not_configured',
    detail: workers.running
      ? `${workers.inFlightCount} in flight, ${workers.idleCount} idle`
      : workers.enabled
        ? 'daemon registered but not running'
        : 'queue worker disabled',
  });
  probes.push({
    name: 'api',
    status: 'ok',
    detail: 'process up',
  });

  return {
    generatedAt: new Date().toISOString(),
    probes,
    queue: { queued, applying, failed, applied, otpRequired, emailProofPending, stuck },
    workers,
    ingest: getIngestRun(),
  };
}

export function trafficLights(probes: ServiceProbe[]): Record<string, ProbeStatus> {
  return Object.fromEntries(probes.map((probe) => [probe.name, probe.status]));
}
