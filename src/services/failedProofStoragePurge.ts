import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { PROOFS_FAILED_BUCKET } from '../db/storage.js';
import { insertAuditEvent } from '../db/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('FailedProofStoragePurge');

export interface FailedProofPurgeOptions {
  preview?: boolean;
  actorEmail?: string;
  actorRole?: string;
}

export interface FailedProofPurgeResult {
  preview: boolean;
  totalFound: number;
  deletedCount: number;
  freedBytesApprox: number;
  updatedApplications: number;
  durationMs: number;
  message: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export async function purgeFailedProofStorage(
  options: FailedProofPurgeOptions = {}
): Promise<FailedProofPurgeResult> {
  const startTime = Date.now();
  const preview = options.preview === true;
  const db = getDbClient();

  if (!isSupabaseConfigured()) {
    throw new Error('Supabase database client is not configured.');
  }

  // 1. Concurrency Safety: Check if an active ingest run or active submission is in-flight
  const { data: runningIngest } = await db
    .from('ingest_runs')
    .select('id')
    .eq('status', 'running')
    .limit(1);

  if (runningIngest && runningIngest.length > 0) {
    throw new Error('Cannot purge failed screenshots while an ingestion run is currently in progress.');
  }

  const { data: activeApplying } = await db
    .from('gh_candidate_applications')
    .select('id')
    .eq('status', 'APPLYING')
    .limit(1);

  if (activeApplying && activeApplying.length > 0) {
    throw new Error('Cannot purge failed screenshots while submission workers are actively processing applications.');
  }

  // 2. Count matching application rows whose pointers will be cleared
  const { count: matchingApplicationsCount, error: appCountError } = await db
    .from('gh_candidate_applications')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'FAILED')
    .not('proof_failed_url', 'is', null);

  if (appCountError) {
    log.warn(`[PurgeFailedProofs] Failed to count matching applications: ${appCountError.message}`);
  }

  const appCount = matchingApplicationsCount ?? 0;

  // 3. Preview Mode: Scan files and calculate approximate size without mutating state
  if (preview) {
    let previewTotalFound = 0;
    let previewBytes = 0;
    let offset = 0;
    let iteration = 0;

    while (iteration < MAX_PAGES) {
      const { data: batch, error } = await db.storage
        .from(PROOFS_FAILED_BUCKET)
        .list('', { limit: PAGE_SIZE, offset });

      if (error) {
        log.error(`[PurgeFailedProofs] Preview listing error: ${error.message}`);
        break;
      }

      if (!batch || batch.length === 0) {
        break;
      }

      previewTotalFound += batch.length;
      for (const item of batch) {
        previewBytes += Number(item.metadata?.size || 0);
      }

      if (batch.length < PAGE_SIZE) {
        break;
      }

      offset += batch.length;
      iteration++;
    }

    const durationMs = Date.now() - startTime;
    const mbEstimate = (previewBytes / (1024 * 1024)).toFixed(1);

    return {
      preview: true,
      totalFound: previewTotalFound,
      deletedCount: 0,
      freedBytesApprox: previewBytes,
      updatedApplications: appCount,
      durationMs,
      message: `Preview: Found ${previewTotalFound} failed screenshots (~${mbEstimate} MB) and ${appCount} application links ready to purge.`,
    };
  }

  // 4. Confirm Mode: Execution Loop
  // Critical: When deleting elements from storage, keep offset at 0 to avoid the pagination-shift bug.
  let deletedCount = 0;
  let freedBytesApprox = 0;
  let iteration = 0;
  const attempted = new Set<string>();

  while (iteration < MAX_PAGES) {
    const { data: batch, error } = await db.storage
      .from(PROOFS_FAILED_BUCKET)
      .list('', { limit: PAGE_SIZE, offset: 0 });

    if (error) {
      log.error(`[PurgeFailedProofs] Storage listing failed: ${error.message}`);
      break;
    }

    if (!batch || batch.length === 0) {
      break;
    }

    // Filter to files we haven't already attempted in this run
    const newFiles = batch.filter((f) => f.name && !attempted.has(f.name));
    if (newFiles.length === 0) {
      // All remaining items were already attempted and failed deletion
      log.warn(`[PurgeFailedProofs] Terminating deletion loop: ${batch.length} files could not be removed.`);
      break;
    }

    for (const f of newFiles) {
      attempted.add(f.name);
      freedBytesApprox += Number(f.metadata?.size || 0);
    }

    const fileNames = newFiles.map((f) => f.name);
    const { error: removeError } = await db.storage
      .from(PROOFS_FAILED_BUCKET)
      .remove(fileNames);

    if (removeError) {
      log.error(`[PurgeFailedProofs] Batch removal error: ${removeError.message}`);
      break;
    }

    deletedCount += fileNames.length;
    iteration++;
  }

  // 5. Surgically clear dead screenshot pointers on historical FAILED records
  let updatedApplications = 0;
  if (appCount > 0) {
    const { error: updateError } = await db
      .from('gh_candidate_applications')
      .update({
        proof_failed_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq('status', 'FAILED')
      .not('proof_failed_url', 'is', null);

    if (updateError) {
      log.error(`[PurgeFailedProofs] Failed to update application pointers: ${updateError.message}`);
    } else {
      updatedApplications = appCount;
    }
  }

  const durationMs = Date.now() - startTime;
  const mbReclaimed = (freedBytesApprox / (1024 * 1024)).toFixed(1);

  // 6. Record Audit Event
  await insertAuditEvent({
    actorEmail: options.actorEmail || 'admin',
    actorRole: options.actorRole || 'admin',
    action: 'FAILED_PROOFS_PURGED',
    metadata: {
      deletedScreenshots: deletedCount,
      freedBytesApprox,
      updatedApplications,
      durationMs,
    },
  });

  const message = `Successfully purged ${deletedCount} failed screenshots (~${mbReclaimed} MB) and cleared ${updatedApplications} application links.`;
  log.info(`[PurgeFailedProofs] ${message}`);

  return {
    preview: false,
    totalFound: deletedCount,
    deletedCount,
    freedBytesApprox,
    updatedApplications,
    durationMs,
    message,
  };
}
