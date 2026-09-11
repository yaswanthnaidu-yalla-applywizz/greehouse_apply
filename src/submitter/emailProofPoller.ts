/**
 * @fileoverview Background Email Proof Poller & Verification Engine.
 *
 * For applications transitioning to EMAIL_PROOF_PENDING after web confirmation:
 * Polls Zoho Mail every 30 seconds for up to 10 minutes (20 attempts).
 * Validates timestamp (>= applied_at - 2m) AND company name.
 * On match: promotes application status from EMAIL_PROOF_PENDING to APPLIED with proof_email_json.
 * On 10m timeout: flags application with email_proof_status = 'manual_review_needed', manual_email_review = true.
 */

import { queryZohoConfirmationEmail } from '../services/zoho-connector.js';
import {
  getApplication,
  updateStatus,
  attachEmailProofJsonToApplication,
  type ApplicationRow,
} from '../db/applications.js';
import { getProfile, getCompanyEmail } from '../db/profiles.js';

export class EmailProofPoller {
  private activePollers = new Map<string, NodeJS.Timeout>();
  private pollerStartTimes = new Map<string, number>();

  public startPolling(application: ApplicationRow): void {
    const appId = application.id || application.applywizz_id;
    if (!appId) return;

    if (this.activePollers.has(appId)) {
      console.log(`[Email Proof Poller] ℹ️ Poller already running for ${appId}`);
      return;
    }

    const startTime = Date.now();
    this.pollerStartTimes.set(appId, startTime);
    const maxDurationMs = 10 * 60 * 1000; // 10 minutes
    const intervalMs = 30 * 1000; // 30 seconds
    const appliedIso = application.submitted_at || application.proof_captured_at || new Date().toISOString();

    console.log(
      `[Email Proof Poller] 🚀 Starting 30s background retry for ${appId} (company: "${application.company_name || 'unknown'}", up to 10 min)...`
    );

    const poll = async () => {
      try {
        const currentApp = await getApplication(appId, application.job_url);
        if (!currentApp) {
          this.stopPolling(appId);
          return;
        }

        // If already APPLIED or already has captured email proof, stop
        if (currentApp.status === 'APPLIED' || currentApp.proof_email_json) {
          console.log(`[Email Proof Poller] ✅ Application ${appId} is already APPLIED / captured. Stopping poller.`);
          this.stopPolling(appId);
          return;
        }

        // Check if 10 minutes have elapsed
        if (Date.now() - startTime >= maxDurationMs) {
          console.warn(
            `[Email Proof Poller] ⏱️ 10 minutes elapsed with zero email matches for ${appId}. Flagging for manual operator review.`
          );
          const targetId = currentApp.id || appId;
          await updateStatus(targetId, 'EMAIL_PROOF_PENDING', {
            email_proof_status: 'manual_review_needed',
            error_message: 'Confirmation email not found after 10m automatic polling. Manual operator review required.',
            job_url: currentApp.job_url,
          }).catch(() => {});

          this.stopPolling(appId);
          return;
        }

        // Fetch company email
        const profile = await getProfile(currentApp.applywizz_id);
        const companyEmail = profile ? getCompanyEmail(profile) : null;
        if (!companyEmail) {
          console.warn(`[Email Proof Poller] ⚠️ No company email for ${appId}. Stopping poller.`);
          this.stopPolling(appId);
          return;
        }

        const companyName = (currentApp.company_name || '').trim();
        if (!companyName) {
          console.warn(`[Email Proof Poller] ⚠️ Missing company_name on ${appId}. Skipping cycle.`);
          return;
        }

        const result = await queryZohoConfirmationEmail({
          candidateEmail: companyEmail,
          companyName,
          companyEmail: (currentApp as any).company_email || undefined,
          submissionTime: appliedIso,
          timeoutMs: 15000,
        });

        if (result.matched && result.email) {
          console.log(
            `[Email Proof Poller] 🎉 Found matching confirmation email for ${appId}! Transitioning to APPLIED.`
          );
          const targetId = currentApp.id || appId;
          const appRef = {
            id: currentApp.id,
            applywizz_id: currentApp.applywizz_id,
            job_url: currentApp.job_url,
          };

          await attachEmailProofJsonToApplication(appRef, result.email, result.email.received_at);
          await updateStatus(targetId, 'APPLIED', {
            proof_email_json: result.email,
            proof_email_captured_at: result.email.received_at,
            email_proof_status: 'captured',
            job_url: currentApp.job_url,
          });

          this.stopPolling(appId);
          return;
        } else {
          console.log(
            `[Email Proof Poller] ⏳ Zero matches on cycle for ${appId}. Next retry in 30s (${Math.round((Date.now() - startTime) / 1000)}s / 600s elapsed)...`
          );
        }
      } catch (err: any) {
        console.warn(`[Email Proof Poller] ⚠️ Poller cycle warning for ${appId}: ${err.message}`);
      }

      // Schedule next poll attempt in 30 seconds
      if (this.activePollers.has(appId)) {
        const timer = setTimeout(poll, intervalMs);
        this.activePollers.set(appId, timer);
      }
    };

    // First background cycle after 30 seconds
    const timer = setTimeout(poll, intervalMs);
    this.activePollers.set(appId, timer);
  }

  public stopPolling(appId: string): void {
    const timer = this.activePollers.get(appId);
    if (timer) {
      clearTimeout(timer);
      this.activePollers.delete(appId);
      this.pollerStartTimes.delete(appId);
      console.log(`[Email Proof Poller] 🛑 Stopped poller for ${appId}`);
    }
  }

  public isPolling(appId: string): boolean {
    return this.activePollers.has(appId);
  }
}

export const emailProofPoller = new EmailProofPoller();
