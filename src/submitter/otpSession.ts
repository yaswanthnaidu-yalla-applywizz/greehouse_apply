/**
 * @fileoverview Submission Session Management & OTP Resumption Engine (Phase V2-4).
 *
 * Tracks active paused browser sessions waiting for automated OTP verification,
 * and executes multi-signal Greenhouse submission verification.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import type { ApplicationRow } from '../db/applications.js';
import { createLogger } from '../utils/logger.js';
import { browserManager } from './browserManager.js';
import { captureFailedScreenshot } from './proofCapture.js';
import {
  DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
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

export interface SubmissionSession {
  applicationId: string;
  browser: Browser;
  page: Page;
  context?: BrowserContext;
  application?: ApplicationRow;
  startedAt?: number;
  pausedAt?: number;
  browserId?: string;
  otpFieldSelector?: string;
  jobUrl?: string;
  applywizzId?: string;
  otpDetectedAt?: number;
  requiresOtp?: boolean;
  multiBox?: boolean;
  boxCount?: number;
  boxSelectors?: string[];
  screenshotCaptured?: boolean;
  ttlTimer?: NodeJS.Timeout;
}

export type ActiveSubmissionSession = SubmissionSession;
export type PausedSession = SubmissionSession;

/**
 * Unified in-memory registry of active browser contexts paused for OTP resolution.
 */
export const activeSubmissions = new Map<string, SubmissionSession>();
export const PAUSED_SESSIONS = activeSubmissions;

/**
 * Builds OTP pause metadata from a post-submit field detection result.
 */
export function buildOtpPauseMetadata(otpField: {
  found: boolean;
  selector?: string;
  multiBox?: boolean;
  boxCount?: number;
  boxSelectors?: string[];
}): Pick<
  SubmissionSession,
  | 'otpFieldSelector'
  | 'otpDetectedAt'
  | 'requiresOtp'
  | 'multiBox'
  | 'boxCount'
  | 'boxSelectors'
> {
  if (otpField.found && otpField.selector) {
    return {
      otpFieldSelector: otpField.selector,
      otpDetectedAt: Date.now(),
      requiresOtp: true,
      multiBox: otpField.multiBox,
      boxCount: otpField.boxCount,
      boxSelectors: otpField.boxSelectors,
    };
  }

  return {
    requiresOtp: false,
  };
}

/**
 * Stores a paused session in the unified session registry.
 * Keyed by applicationId, with secondary aliases for applywizz_id or DB UUID.
 */
export function storePausedSession(
  applicationOrId: ApplicationRow | string,
  session: {
    browser: Browser;
    page: Page;
    context?: BrowserContext;
    browserId?: string;
    applicationId?: string;
    otpFieldSelector?: string;
    pausedAt?: number;
    jobUrl?: string;
    applywizzId?: string;
    otpDetectedAt?: number;
    requiresOtp?: boolean;
    multiBox?: boolean;
    boxCount?: number;
    boxSelectors?: string[];
    screenshotCaptured?: boolean;
  }
): string {
  const canonicalKey: string =
    session.applicationId ||
    (typeof applicationOrId === 'string'
      ? applicationOrId
      : applicationOrId.id || applicationOrId.applywizz_id) ||
    'unknown';
  const applywizzId: string =
    typeof applicationOrId === 'string'
      ? session.applywizzId || canonicalKey
      : applicationOrId.applywizz_id || canonicalKey;
  const pausedAt = session.pausedAt ?? Date.now();
  const jobUrl =
    session.jobUrl ??
    (typeof applicationOrId === 'string' ? '' : applicationOrId.job_url || '');

  const existing = activeSubmissions.get(canonicalKey);
  if (existing?.ttlTimer) {
    clearTimeout(existing.ttlTimer);
  }

  const ttlTimer = setTimeout(async () => {
    log.warn(
      `[OTP Session] ⏰ Paused OTP session ${canonicalKey} timed out after ${OTP_SESSION_TTL_MS / 60000}m. Closing browser context...`
    );
    await clearPausedSession(canonicalKey);
  }, OTP_SESSION_TTL_MS);

  if (ttlTimer.unref) {
    ttlTimer.unref();
  }

  const fullSession: SubmissionSession = {
    browser: session.browser,
    page: session.page,
    context: session.context,
    browserId: session.browserId,
    otpFieldSelector: session.otpFieldSelector,
    applicationId: canonicalKey,
    pausedAt,
    startedAt: pausedAt,
    jobUrl,
    applywizzId,
    otpDetectedAt: session.otpDetectedAt ?? pausedAt,
    requiresOtp: session.requiresOtp ?? Boolean(session.otpFieldSelector),
    multiBox: session.multiBox,
    boxCount: session.boxCount,
    boxSelectors: session.boxSelectors,
    screenshotCaptured: session.screenshotCaptured ?? false,
    ttlTimer,
  };

  activeSubmissions.set(canonicalKey, fullSession);
  if (typeof applicationOrId !== 'string' && applicationOrId.id && applicationOrId.id !== canonicalKey) {
    activeSubmissions.set(applicationOrId.id, fullSession);
  }
  if (applywizzId && applywizzId !== canonicalKey) {
    activeSubmissions.set(applywizzId, fullSession);
  }

  return canonicalKey;
}

/**
 * Resolves a paused session by applicationId, applywizz_id, or any alias key.
 */
export function resolvePausedSession(
  id: string
): { session: SubmissionSession; canonicalKey: string } | null {
  const cleanId = (id || '').trim();
  if (!cleanId) return null;

  const direct = activeSubmissions.get(cleanId);
  if (direct) {
    return { session: direct, canonicalKey: direct.applicationId || cleanId };
  }

  for (const [key, session] of activeSubmissions.entries()) {
    if (session.applicationId === cleanId || session.applywizzId === cleanId) {
      return { session, canonicalKey: session.applicationId || key };
    }
  }

  return null;
}

/**
 * Closes and removes a registered paused submission session.
 */
export async function clearPausedSession(
  id: string,
  options: { captureFailureProof?: boolean } = {}
): Promise<void> {
  const resolved = resolvePausedSession(id);
  if (!resolved) {
    activeSubmissions.delete(id);
    return;
  }

  const { session } = resolved;
  if (session.ttlTimer) {
    clearTimeout(session.ttlTimer);
  }
  try {
    if (
      options.captureFailureProof !== false &&
      session.page &&
      (typeof session.page.isClosed !== 'function' || !session.page.isClosed()) &&
      !session.screenshotCaptured
    ) {
      try {
        await captureFailedScreenshot(session.page, session.applicationId);
        session.screenshotCaptured = true;
      } catch {}
    }
    await session.page?.close().catch(() => {});
    await session.context?.close().catch(() => {});
    if (session.browserId) {
      await browserManager.releaseBrowser(session.browserId).catch(() => {});
    } else {
      await session.browser?.close().catch(() => {});
    }
  } finally {
    for (const [key, value] of activeSubmissions.entries()) {
      if (value === session) {
        activeSubmissions.delete(key);
      }
    }
    if (session.applicationId) activeSubmissions.delete(session.applicationId);
    if (session.applywizzId) activeSubmissions.delete(session.applywizzId);
    log.info(`[OTP Session] 🧹 Cleaned up session for application ${session.applicationId || id}`);
  }
}

/**
 * Registers an active browser context session in memory.
 */
export function registerSubmissionSession(session: ActiveSubmissionSession): void {
  storePausedSession(session.applicationId, session);
}

/**
 * Closes and removes a registered paused submission session.
 */
export async function closeSubmissionSession(applicationId: string): Promise<void> {
  await clearPausedSession(applicationId);
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

      // Fast check for Greenhouse server error banner
      const SERVER_ERROR_RE =
        /there was an error processing your application|we were unable to submit|something went wrong|internal server error|a server error occurred/i;
      if (SERVER_ERROR_RE.test(bodyText)) {
        const match = bodyText.match(SERVER_ERROR_RE)?.[0] || 'Greenhouse server error';
        return { verified: false, error: `GREENHOUSE_SERVER_ERROR: ${match}` };
      }

      // 4. Fast check for inline validation or server errors
      const errorSelectors = [
        '.field-error',
        '.field_error',
        '.field-with-errors',
        '.field__error-text',
        '.inline-error',
        '.errors',
        '.error-message',
        '[class*="error-message"]',
        '.flash-error',
        '.validation-error',
        '[aria-invalid="true"]',
        'span.error:not(:empty)',
        'div.error:not(:empty)',
        'p.error:not(:empty)',
        'label.error:not(:empty)',
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
