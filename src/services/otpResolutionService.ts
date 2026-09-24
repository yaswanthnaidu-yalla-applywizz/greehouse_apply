import { createLogger } from '../utils/logger.js';
import {
  getApplication,
  updateStatus,
  MAX_SUBMISSION_RETRIES,
} from '../db/applications.js';
import { zohoReaderPool } from './zohoReader.js';
import { config } from '../config/env.js';

const log = createLogger('OTP Resolution');

export interface OtpPendingEntry {
  applicationId: string;
  email: string;
  sinceTimestamp: number;
  sessionKey: string;
  attemptCount: number;
  claimed: boolean;
}

const pendingEntries = new Map<string, OtpPendingEntry>();

class OtpResolutionService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  public register(entry: Omit<OtpPendingEntry, 'claimed'>): void {
    pendingEntries.set(entry.applicationId, { ...entry, claimed: false });
    log.info(`[OTP Resolution] Registered pending OTP for ${entry.applicationId}`);
  }

  public cancel(applicationId: string): void {
    pendingEntries.delete(applicationId);
  }

  public start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.processPending();
    }, config.OTP_RESOLUTION_POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.processPending();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async processPending(): Promise<void> {
    if (!this.running) return;
    const entries = Array.from(pendingEntries.values());
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.claimed) return;
        entry.claimed = true;
        await this.processEntry(entry).catch((error: unknown) => {
          log.error(
            `[OTP Resolution] Unexpected failure for ${entry.applicationId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          entry.claimed = false;
        });
      })
    );
  }

  private async processEntry(entry: OtpPendingEntry): Promise<void> {
    const liveSubmit = await import('../submitter/liveSubmit.js');
    if (!liveSubmit.resolvePausedSession(entry.sessionKey)) {
      await updateStatus(entry.applicationId, 'RETRY', {
        error_message: 'OTP session expired before resolution.',
      }).catch(() => {});
      this.cancel(entry.applicationId);
      return;
    }

    entry.attemptCount += 1;
    try {
      const application = await getApplication(entry.applicationId);
      if (!application) {
        this.cancel(entry.applicationId);
        return;
      }

      const reader = await zohoReaderPool.acquireReader();
      let result;
      try {
        result = await reader.fetchLatestOtp(entry.email, {
          timeoutMs: config.OTP_ATTEMPT_TIMEOUT_MS,
          sinceTimestamp: entry.sinceTimestamp,
          companyName: application.company_name || undefined,
        });
      } finally {
        zohoReaderPool.releaseReader(reader);
      }

      if (result.success && result.otp) {
        const submitResult = await liveSubmit.submitOtpToPausedSession(
          entry.sessionKey,
          result.otp,
          { jobUrl: application.job_url }
        );
        if (submitResult.status === 'APPLIED' || submitResult.status === 'EMAIL_PROOF_PENDING') {
          await updateStatus(entry.applicationId, 'APPLIED', {
            proof_web_url: submitResult.proofWebUrl,
            proof_captured_at: submitResult.proofCapturedAt,
            job_url: application.job_url,
          }).catch(() => {});
          this.cancel(entry.applicationId);
          return;
        }
      }
    } catch (error: unknown) {
      log.warn(
        `[OTP Resolution] Attempt failed for ${entry.applicationId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (entry.attemptCount >= MAX_SUBMISSION_RETRIES) {
      await updateStatus(entry.applicationId, 'RETRY', {
        error_message: 'OTP resolution retry budget exhausted.',
      }).catch(() => {});
      this.cancel(entry.applicationId);
      return;
    }

    entry.claimed = false;
    log.warn(
      `[OTP Resolution] OTP attempt failed for ${entry.applicationId}; ` +
        `attempt=${entry.attemptCount}/${MAX_SUBMISSION_RETRIES}`
    );
  }
}

export const otpResolutionService = new OtpResolutionService();
export default otpResolutionService;
