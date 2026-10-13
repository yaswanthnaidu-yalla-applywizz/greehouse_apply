/**
 * @fileoverview Submission Session Management & OTP Resumption Engine (Phase V2-4).
 *
 * Tracks active paused browser sessions waiting for automated OTP verification,
 * and executes multi-signal Greenhouse submission verification.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import type { ApplicationRow } from '../db/applications.js';
import { createLogger } from '../utils/logger.js';
import {
  DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
  OTP_CHALLENGE_TIMEOUT_MS,
  OTP_SESSION_TTL_MS,
  SPINNER_EXTENDED_TIMEOUT_MS,
} from './otpTimeouts.js';

export {
  DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
  OTP_CHALLENGE_TIMEOUT_MS,
  OTP_SESSION_TTL_MS,
  SPINNER_EXTENDED_TIMEOUT_MS,
} from './otpTimeouts.js';

const log = createLogger('OTP Session');

export interface ActiveSubmissionSession {
  applicationId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  application: ApplicationRow;
  startedAt: number;
  ttlTimer?: NodeJS.Timeout;
}

/**
 * In-memory registry of active browser contexts paused for OTP resolution.
 */
export const activeSubmissions = new Map<string, ActiveSubmissionSession>();

/**
 * Registers an active browser context session in memory.
 * Sets a safety timeout longer than the OTP challenge budget by the confirmation grace.
 */
export function registerSubmissionSession(session: ActiveSubmissionSession): void {
  const existing = activeSubmissions.get(session.applicationId);
  if (existing?.ttlTimer) {
    clearTimeout(existing.ttlTimer);
  }

  const ttlTimer = setTimeout(async () => {
    log.warn(
      `[OTP Session] ⏰ Paused session for application ${session.applicationId} reached ${OTP_SESSION_TTL_MS / 60000}m TTL. Closing browser context...`
    );
    await closeSubmissionSession(session.applicationId);
  }, OTP_SESSION_TTL_MS);

  activeSubmissions.set(session.applicationId, {
    ...session,
    ttlTimer,
  });

  log.info(
    `[OTP Session] 📌 Registered paused OTP session for application ${session.applicationId} (TTL: ${OTP_SESSION_TTL_MS / 60000}m; OTP budget: ${OTP_CHALLENGE_TIMEOUT_MS / 60000}m + ${SPINNER_EXTENDED_TIMEOUT_MS / 1000}s confirmation grace)`
  );
}

/**
 * Closes and removes a registered paused submission session.
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
      try {
        const { PAUSED_SESSIONS } = await import('./liveSubmit.js');
        PAUSED_SESSIONS.delete(applicationId);
      } catch {}
      log.info(`[OTP Session] 🧹 Cleaned up session for application ${applicationId}`);
    }
  }
}

/**
 * Checks whether the submit button has an active loading spinner animation.
 */
export async function isSubmitButtonSpinnerActive(page: Page): Promise<boolean> {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;
  return page
    .evaluate(() => {
      const btn = document.querySelector('button[type="submit"], input[type="submit"]');
      if (!btn) return false;
      return (
        btn.classList.contains('loading') ||
        btn.getAttribute('aria-busy') === 'true' ||
        btn.querySelector('.loading, .spinner, [class*="spin"]') !== null ||
        btn.querySelector('svg[class*="animate"]') !== null
      );
    })
    .catch(() => false);
}

/**
 * Checks for multi-signal Greenhouse confirmation tokens:
 * 1. Document Title
 * 2. DOM innerText keywords
 * 3. URL patterns
 * 4. Fast form validation error aborts
 * 5. Spinner-aware polling up to spinnerExtendedTimeoutMs
 */
export async function verifySubmissionSignals(
  page: Page,
  timeoutMs: number = DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
  spinnerExtendedTimeoutMs: number = SPINNER_EXTENDED_TIMEOUT_MS
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

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      if (elapsed < spinnerExtendedTimeoutMs) {
        const spinnerActive = await isSubmitButtonSpinnerActive(page);
        if (!spinnerActive) {
          break;
        }
      } else {
        break;
      }
    }

    try {
      if (page.isClosed()) {
        return { verified: false, error: 'Browser page was closed before confirmation.' };
      }

      // 1. Signal 1: Document title
      const title = await page.title().catch(() => '');
      if (/thank you for applying|thanks for applying|application submitted|application received/i.test(title)) {
        return { verified: true, signal: `document.title matches: "${title}"` };
      }

      // 2. Signal 2: Current URL navigation
      const currentUrl = page.url();
      if (
        currentUrl.includes('/confirmation') ||
        (currentUrl.includes('/jobs/') && currentUrl.includes('/applied')) ||
        currentUrl.includes('status=submitted')
      ) {
        return { verified: true, signal: `confirmation URL reached: ${currentUrl}` };
      }

      // 3. Signal 3: DOM body text tokens
      const bodyText: string =
        (await page.evaluate<string>(() => (document.body ? document.body.innerText.toLowerCase() : '')).catch(() => '')) || '';
      for (const token of CONFIRMATION_TOKENS) {
        if (bodyText.includes(token)) {
          return { verified: true, signal: `body text token matched: "${token}"` };
        }
      }

      // 4. Fast check for inline validation or server errors
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
              if (Date.now() - startTime > 2000) {
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

  const finalElapsedSec = Math.round((Date.now() - startTime) / 1000);
  return { verified: false, error: `Timeout: Submission verification timed out after ${finalElapsedSec}s.` };
}
