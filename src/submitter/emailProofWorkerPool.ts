/**
 * @fileoverview Multi-Replica Email Proof Worker Pool (Phase V2-7).
 *
 * Runs up to 3 concurrent worker lanes per replica to process EMAIL_PROOF_PENDING applications.
 * Replicas coordinate via atomic PostgreSQL RPC `claim_next_email_proof_application`
 * and Supabase Realtime channel broadcast for trigger synchronization.
 */

import { claimNextEmailProofApplication } from '../db/applications/queue.js';
import {
  attachEmailProofJsonToApplication,
  updateEmailProofStatus,
  updateStatus,
  type ApplicationRow,
} from '../db/applications.js';
import { getProfile, getCompanyEmail } from '../db/profiles.js';
import { queryConfirmationEmail } from '../services/zoho-connector.js';
import { isEmailMessageIdAlreadyAttached } from './proofCapture.js';
import { isSupabaseConfigured, getDbClient } from '../db/client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Email Proof Worker Pool');

export interface EmailProofWorkerPoolOptions {
  concurrency?: number;
}

export interface EmailProofWorkerSnapshot {
  maxWorkers: number;
  activeWorkers: number;
  isBatchActive: boolean;
  isRunning: boolean;
}

export class EmailProofWorkerPool {
  private readonly maxWorkers: number;
  private activeWorkers = 0;
  private isRunning = false;
  private isBatchActive = false;
  private realtimeChannel: any = null;

  public constructor(options: EmailProofWorkerPoolOptions = {}) {
    const requested = options.concurrency ?? 3;
    this.maxWorkers = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 3) : 3;
  }

  public getSnapshot(): EmailProofWorkerSnapshot {
    return {
      maxWorkers: this.maxWorkers,
      activeWorkers: this.activeWorkers,
      isBatchActive: this.isBatchActive,
      isRunning: this.isRunning,
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    log.info(`[Email Proof Pool] Starting pool with ${this.maxWorkers} worker lanes.`);
    this.setupRealtimeListener();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.isBatchActive = false;
    if (this.realtimeChannel && isSupabaseConfigured()) {
      try {
        const client = getDbClient();
        await client.removeChannel(this.realtimeChannel);
      } catch (err: any) {
        log.warn(`[Email Proof Pool] Failed to remove realtime channel: ${err.message}`);
      }
      this.realtimeChannel = null;
    }
    log.info(`[Email Proof Pool] Stopped.`);
  }

  public async triggerBatch(): Promise<void> {
    if (this.isBatchActive) {
      log.info(`[Email Proof Pool] Batch is already in-flight.`);
      return;
    }
    this.isBatchActive = true;
    log.info(`[Email Proof Pool] 🚀 Triggering batch run across ${this.maxWorkers} lanes.`);

    for (let i = 0; i < this.maxWorkers; i++) {
      void this.runWorkerLane(i);
    }
  }

  private setupRealtimeListener(): void {
    if (!isSupabaseConfigured()) return;
    try {
      const client = getDbClient();
      this.realtimeChannel = client.channel('email_proof_batch');
      this.realtimeChannel
        .on('broadcast', { event: 'START_BATCH' }, () => {
          log.info(`[Email Proof Pool] Received START_BATCH broadcast from Realtime.`);
          void this.triggerBatch();
        })
        .subscribe();
    } catch (err: any) {
      log.warn(`[Email Proof Pool] Could not set up realtime subscription: ${err.message}`);
    }
  }

  private async runWorkerLane(laneIndex: number): Promise<void> {
    this.activeWorkers++;
    log.info(`[Email Proof Pool] Worker lane ${laneIndex + 1}/${this.maxWorkers} active.`);

    try {
      while (this.isRunning && this.isBatchActive) {
        const app = await claimNextEmailProofApplication();
        if (!app) {
          log.info(`[Email Proof Pool] Lane ${laneIndex + 1}: No more pending applications. Exiting lane.`);
          break;
        }

        try {
          await this.processApplication(app);
        } catch (err: any) {
          log.error(`[Email Proof Pool] Error processing app ${app.id || app.applywizz_id}: ${err.message}`);
        }

        // Pacing delay between Zoho queries to respect rate limits
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (this.activeWorkers === 0) {
        this.isBatchActive = false;
        log.info(`[Email Proof Pool] All lanes finished. Batch complete.`);
      }
    }
  }

  public async processApplication(app: ApplicationRow): Promise<boolean> {
    const appId = app.id || app.applywizz_id;
    const companyName = (app.company_name || '').trim();
    if (!companyName) {
      log.warn(`[Email Proof Pool] ⚠️ Missing company_name on ${appId}`);
      await updateEmailProofStatus(app, 'manual_review_needed');
      return false;
    }

    const profile = await getProfile(app.applywizz_id);
    const candidateEmail = profile ? getCompanyEmail(profile) : null;
    if (!candidateEmail) {
      log.warn(`[Email Proof Pool] ⚠️ No company email found for candidate ${app.applywizz_id}`);
      await updateEmailProofStatus(app, 'manual_review_needed');
      return false;
    }

    const appliedIso = app.submitted_at || app.proof_captured_at || app.reviewed_at || new Date().toISOString();

    const result = await queryConfirmationEmail({
      candidateEmail,
      companyName,
      companyEmail: (app as any).company_email || undefined,
      submissionTime: appliedIso,
      allowHistorical: true,
      timeoutMs: 30000,
      ats: (app as any).ats || 'greenhouse',
      jobTitle: (app as any).job_title || (app as any).title,
    });

    if (result.matched && result.email) {
      // Check messageId deduplication to avoid attaching the same email to multiple applications
      if (result.email.messageId) {
        const alreadyAttached = await isEmailMessageIdAlreadyAttached(result.email.messageId);
        if (alreadyAttached) {
          log.warn(
            `[Email Proof Pool] ⚠️ Matched email messageId "${result.email.messageId}" is already attached to another application. Rejecting duplicate match.`
          );
          await updateEmailProofStatus(app, 'manual_review_needed');
          return false;
        }
      }

      const capturedAt = result.email.received_at || new Date().toISOString();
      const attached = await attachEmailProofJsonToApplication(app, result.email, capturedAt);
      if (attached) {
        log.info(
          `[Email Proof Pool] 🎉 Proof attached for ${appId} ("${result.email.subject}"). Promoting to APPLIED.`
        );
        await updateStatus(app.id || appId, 'APPLIED', {
          job_url: app.job_url,
          email_proof_status: 'verified',
        });
        return true;
      }
    }

    log.info(`[Email Proof Pool] ℹ️ Confirmation email not found for ${appId}. Setting status to manual_review_needed.`);
    await updateEmailProofStatus(app, 'manual_review_needed');
    return false;
  }
}

export const emailProofWorkerPool = new EmailProofWorkerPool();
