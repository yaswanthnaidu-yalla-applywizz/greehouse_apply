/**
 * @fileoverview Submission Session Management & CAPTCHA Resumption Engine (Phase V2-4).
 *
 * Tracks active paused browser sessions waiting for operator manual CAPTCHA solving,
 * and allows resuming submission once the challenge is cleared.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { captureWebProof, captureFailedScreenshot, captureAndSaveEmailProof } from './proofCapture.js';
import { emailProofPoller } from './emailProofPoller.js';
import { updateStatus, getApplication, type ApplicationRow } from '../db/applications.js';
import type { LiveSubmitResult } from './liveSubmit.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Captcha Resume');

export interface ActiveSubmissionSession {
  applicationId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  application: ApplicationRow;
  startedAt: number;
  ttlTimer?: NodeJS.Timeout;
}

/** 30-minute timeout for paused CAPTCHA sessions to prevent leaking browser contexts */
export const CAPTCHA_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * In-memory registry of active browser contexts paused for CAPTCHA resolution.
 */
export const activeSubmissions = new Map<string, ActiveSubmissionSession>();

/**
 * Checks whether an active paused session exists for the given application.
 */
export function hasActiveSubmissionSession(applicationId: string): boolean {
  return activeSubmissions.has(applicationId);
}

/**
 * Registers an active paused browser session.
 */
export function registerSubmissionSession(session: ActiveSubmissionSession): void {
  const existing = activeSubmissions.get(session.applicationId);
  if (existing?.ttlTimer) {
    clearTimeout(existing.ttlTimer);
  }

  const timer = setTimeout(async () => {
    log.warn(
      `[Captcha Resume] ⏰ Paused session for application ${session.applicationId} timed out after 30m. Closing browser context...`
    );
    await closeSubmissionSession(session.applicationId);
  }, CAPTCHA_SESSION_TTL_MS);

  if (timer.unref) {
    timer.unref();
  }

  session.ttlTimer = timer;
  activeSubmissions.set(session.applicationId, session);
  log.info(`[Captcha Resume] ⏸️ Registered paused session for application ${session.applicationId} (TTL: 30m)`);
}

/**
 * Cleans up and removes an active browser session from memory.
 */
export async function closeSubmissionSession(applicationId: string): Promise<void> {
  const session = activeSubmissions.get(applicationId);
  if (session) {
    if (session.ttlTimer) {
      clearTimeout(session.ttlTimer);
    }
    try {
      await session.page.close().catch(() => {});
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
    } finally {
      activeSubmissions.delete(applicationId);
      log.info(`[Captcha Resume] 🧹 Cleaned up session for application ${applicationId}`);
    }
  }
}

/**
 * Resumes a submission that was paused due to CAPTCHA detection.
 * Clicks the submit button, waits for multi-signal completion verification,
 * captures the web proof, and transitions state to APPLIED.
 *
 * @param applicationId - Application ID to resume
 * @returns Result of the resumed submission
 */
export async function resumeSubmission(applicationId: string): Promise<LiveSubmitResult> {
  const session = activeSubmissions.get(applicationId);

  if (!session) {
    // If no paused in-memory session exists, check DB status
    const app = await getApplication(applicationId);
    if (!app) {
      throw new Error(`Application '${applicationId}' not found.`);
    }

    throw new Error(
      `No active paused browser session found for application ${applicationId}. Please trigger a fresh submission.`
    );
  }

  const { page, application } = session;

  log.info(`[Captcha Resume] ▶️ Resuming submission for application ${applicationId}...`);

  try {
    // 1. Update status to APPLYING
    if (application.id) {
      await updateStatus(application.id, 'APPLYING');
    }

    // 2. Locate and click submit button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '#submit_app',
      'button:has-text("Submit Application")',
      'input[value*="Submit"]',
      'button:has-text("Apply")',
      '#submit_application',
    ];

    let clicked = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ timeout: 5000 });
        clicked = true;
        log.info(`[Captcha Resume] 🖱️ Clicked submit button (${sel})`);
        break;
      }
    }

    if (!clicked) {
      throw new Error('Submit button not found or not visible on resumed page.');
    }

    // 3. Multi-Signal Completion Verification (up to 30s)
    const verification = await verifySubmissionSignals(page, 30000);

    if (verification.verified) {
      log.info(`[Captcha Resume] ✅ Confirmation verified via signal: ${verification.signal}`);

      // 4. Capture full-page proof screenshot & upload to Supabase Storage
      const proofResult = await captureWebProof(page, application);

      const targetAppId = application.id || applicationId;
      const submittedAt = new Date().toISOString();
      await updateStatus(targetAppId, 'EMAIL_PROOF_PENDING', {
        proof_web_url: proofResult.proofWebUrl,
        proof_captured_at: proofResult.proofCapturedAt,
        job_url: application.job_url,
      });

      await closeSubmissionSession(applicationId);

      // Attempt immediate confirmation email verification (up to 15s)
      log.info(`[Captcha Resume] 📧 Checking for immediate confirmation email after CAPTCHA resume...`);
      const emailProof = await captureAndSaveEmailProof(application, {
        timeoutMs: 15000,
      }).catch(() => null);

      if (emailProof) {
        log.info(`[Captcha Resume] 🎉 Confirmation email verified immediately! Marking APPLIED.`);
        await updateStatus(targetAppId, 'APPLIED', {
          proof_web_url: proofResult.proofWebUrl,
          proof_captured_at: proofResult.proofCapturedAt,
          proof_email_json: emailProof,
          proof_email_captured_at: emailProof.received_at || new Date().toISOString(),
          email_proof_status: 'captured',
          job_url: application.job_url,
        });

        return {
          success: true,
          status: 'APPLIED',
          applicationId,
          proofWebUrl: proofResult.proofWebUrl,
          proofCapturedAt: proofResult.proofCapturedAt,
        };
      }

      // Zero matches on immediate check: transition to EMAIL_PROOF_PENDING & start 30s background retry
      log.info(
        `[Captcha Resume] ⏳ Confirmation email not found immediately. Retrying in background every 30s for up to 10m (EMAIL_PROOF_PENDING)...`
      );
      const appForPoller: ApplicationRow = {
        ...application,
        id: targetAppId,
        submitted_at: submittedAt,
        proof_web_url: proofResult.proofWebUrl,
        proof_captured_at: proofResult.proofCapturedAt,
        status: 'EMAIL_PROOF_PENDING',
      };
      emailProofPoller.startPolling(appForPoller);

      return {
        success: true,
        status: 'EMAIL_PROOF_PENDING',
        applicationId,
        proofWebUrl: proofResult.proofWebUrl,
        proofCapturedAt: proofResult.proofCapturedAt,
      };
    } else {
      const isTimeout = /time.*out/i.test(verification.error || '');
      const errorMsg = verification.error || 'Timeout: Submission verification timed out.';
      if (isTimeout) {
        log.warn(`[Captcha Resume] ⏱️ Timeout: ${errorMsg}`);
      } else {
        log.warn(`[Captcha Resume] ❌ Verification failed: ${errorMsg}`);
      }

      let failedProof: any = null;
      if (page && !page.isClosed()) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
      }

      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: errorMsg,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        });
      }

      await closeSubmissionSession(applicationId);

      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: errorMsg,
        proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
        proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
      };
    }
  } catch (err: any) {
    log.error(`[Captcha Resume] ❌ Error during submission resumption:`, err);

    let errProof: any = null;
    if (page && !page.isClosed()) {
      errProof = await captureFailedScreenshot(page, application).catch(() => null);
    }

    if (application.id) {
      await updateStatus(application.id, 'FAILED', {
        error_message: err.message,
        proof_failed_url: errProof?.proofFailedUrl || errProof?.url,
        proof_failed_captured_at: errProof?.proofFailedCapturedAt || errProof?.capturedAt,
        job_url: application.job_url,
      });
    }
    await closeSubmissionSession(applicationId);

    return {
      success: false,
      status: 'FAILED',
      applicationId,
      errorMessage: err.message,
      proofFailedUrl: errProof?.proofFailedUrl || errProof?.url,
      proofFailedCapturedAt: errProof?.proofFailedCapturedAt || errProof?.capturedAt,
    };
  }
}

/**
 * Checks for multi-signal Greenhouse confirmation tokens:
 * 1. Document Title
 * 2. DOM innerText keywords
 * 3. URL patterns
 */
export async function verifySubmissionSignals(
  page: Page,
  timeoutMs: number = 30000
): Promise<{ verified: boolean; signal?: string; error?: string }> {
  const startTime = Date.now();
  const pollIntervalMs = 500;

  const CONFIRMATION_TOKENS = [
    'thank you for applying',
    'thanks for applying',
    'your application has been submitted',
    'track your application',
    'application received',
    'we have received your application',
    'application submitted',
  ];

  while (Date.now() - startTime < timeoutMs) {
    try {
      // 1. Signal 1: Document title
      const title = await page.title().catch(() => '');
      if (/thank you for applying|thanks for applying|application submitted|application received/i.test(title)) {
        return { verified: true, signal: `document.title matches: "${title}"` };
      }

      // 2. Signal 2: Current URL navigation
      const currentUrl = page.url();
      if (
        currentUrl.includes('/confirmation') ||
        currentUrl.includes('/jobs/') && currentUrl.includes('/applied') ||
        currentUrl.includes('status=submitted')
      ) {
        return { verified: true, signal: `confirmation URL reached: ${currentUrl}` };
      }

      // 3. Signal 3: DOM body text tokens
      const bodyText: string = (await page.evaluate<string>(() => document.body ? document.body.innerText.toLowerCase() : '').catch(() => '')) || '';
      for (const token of CONFIRMATION_TOKENS) {
        if (bodyText.includes(token)) {
          return { verified: true, signal: `body text token matched: "${token}"` };
        }
      }

      // 4. Check for inline validation or server errors
      const errorSelectors = [
        '.field-error',
        '.field_error',
        '.field-with-errors',
        '.errors',
        '.error-message',
        '.flash-error',
        '.validation-error',
        '[aria-invalid="true"]',
      ];
      for (const sel of errorSelectors) {
        const loc = page.locator(sel);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          const firstEl = loc.first();
          if (await firstEl.isVisible().catch(() => false)) {
            const errorText = await firstEl.innerText().catch(() => '');
            if (errorText && errorText.trim().length > 0) {
              if (Date.now() - startTime > 3000) {
                return { verified: false, error: `Form filling error: ${errorText.trim()}` };
              }
            }
          }
        }
      }

      await page.waitForTimeout(pollIntervalMs);
    } catch {
      await page.waitForTimeout(pollIntervalMs);
    }
  }

  return { verified: false, error: `Timeout: Submission verification timed out after ${timeoutMs / 1000}s.` };
}
