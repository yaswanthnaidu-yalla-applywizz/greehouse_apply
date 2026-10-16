/**
 * @fileoverview Playwright Live Submission Engine with post-submit OTP detection (Phase V2-4).
 *
 * Executes automated Greenhouse form submission:
 * 1. Launches isolated Playwright browser context
 * 2. Populates form via formFiller.ts
 * 3. Clicks the submit button
 * 4. Inspects for OTP input fields (post-submit only)
 *    - If detected: transitions status to OTP_REQUIRED and registers paused session
 * 5. Runs multi-signal completion verification (Title / DOM tokens / URL)
 * 6. On confirmation: captures full-page web proof, uploads to Supabase Storage, sets status APPLIED
 * 7. On timeout / failure: captures error details, sets status FAILED
 */

import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { fillForm, formatInvalidFieldLog, type FormFillSummary, type FormFillerOptions } from './formFiller.js';
import {
  captureWebProof,
  captureFailedScreenshot,
  captureJobFailedScreenshot,
  captureJobOtpScreenshot,
  captureJobOpenScreenshot,
  captureJobSubmittedScreenshot,
  captureAndSaveEmailProof,
} from './proofCapture.js';
import { emailProofPoller } from './emailProofPoller.js';
import {
  activeSubmissions,
  registerSubmissionSession,
  verifySubmissionSignals,
  DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
  closeSubmissionSession,
  OTP_SESSION_TTL_MS,
} from './otpSession.js';

export { verifySubmissionSignals };
import {
  getApplication,
  updateStatus,
  upsertApplication,
  type ApplicationRow,
  type ApplicationStatus,
} from '../db/applications.js';
import { getProfile, updateResumeStoragePath } from '../db/profiles.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { uploadResume } from '../db/storage.js';
import { ApplyWizzClient } from '../candidate/applywizzClient.js';
import { otpResolutionService } from '../services/otpResolutionService.js';
import { createLogger } from '../utils/logger.js';
import { assertWithinSubmissionQuestionLimit } from '../submission/questionLimit.js';
import type { SubmissionRetryReason } from './submissionRetry.js';
import { emitFailureDiagnostic } from '../utils/failureDiagnostics.js';
import { captureFailureDiagnostics } from './failureDiagnostics.js';
import { browserManager, type ManagedBrowser } from './browserManager.js';

const log = createLogger('Live Submit');
const RESUMES_BUCKET = 'resumes';

function applicationRequiresResume(application: ApplicationRow): boolean {
  return (application.resolved_fields || []).some((field: any) =>
    String(field?.type || '').toLowerCase() === 'file' ||
    /resume|curriculum vitae|\bcv\b/i.test(`${field?.fieldId || ''} ${field?.name || ''} ${field?.label || ''}`)
  );
}

async function isResumeStorageObjectAvailable(storagePath: string | null | undefined): Promise<boolean> {
  if (!storagePath) return false;
  if (!isSupabaseConfigured()) {
    const localPath = path.resolve(process.cwd(), 'resumes', path.basename(storagePath));
    return fs.existsSync(localPath) && fs.statSync(localPath).size > 100;
  }

  try {
    const objectPath = path.basename(storagePath);
    const { data, error } = await getDbClient().storage.from(RESUMES_BUCKET).download(objectPath);
    if (error || !data) return false;
    return (await data.arrayBuffer()).byteLength > 100;
  } catch (err: any) {
    log.warn(`[Live Submit] ⚠️ Resume storage probe failed: ${err.message}`);
    return false;
  }
}

async function ensureResumeAvailable(application: ApplicationRow): Promise<boolean> {
  if (!applicationRequiresResume(application)) return true;

  const maxAttempts = 3; // 1 initial attempt + 2 retries
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const profile = await getProfile(application.applywizz_id);
      if (await isResumeStorageObjectAvailable(profile?.resume_storage_path)) return true;

      const client = new ApplyWizzClient();
      const refreshed = await client.fetchCandidateProfile(application.applywizz_id, true);
      if (!refreshed.resumeUrl) {
        log.warn(`[Live Submit] ⚠️ Candidate ${application.applywizz_id} profile has no resumeUrl (attempt ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        return false;
      }

      const localPath = await client.downloadResume(application.applywizz_id, refreshed.resumeUrl);
      if (!fs.existsSync(localPath) || fs.statSync(localPath).size <= 100) {
        log.warn(`[Live Submit] ⚠️ Downloaded resume empty/missing for ${application.applywizz_id} (attempt ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        return false;
      }

      const storagePath = await uploadResume(application.applywizz_id, await fs.promises.readFile(localPath), 'application/pdf', {
        firstName: refreshed.firstName,
        lastName: refreshed.lastName,
        workExperience: refreshed.workExperience,
      });
      await updateResumeStoragePath(application.applywizz_id, storagePath);
      const available = await isResumeStorageObjectAvailable(storagePath);
      if (available) return true;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err: any) {
      log.warn(`[Live Submit] ⚠️ Resume preparation attempt ${attempt}/${maxAttempts} failed for ${application.applywizz_id}: ${err.message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return false;
}

export interface LiveSubmitOptions extends FormFillerOptions {
  /** Launch in headless mode (default: true) */
  headless?: boolean;
  /** Navigation and form timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Confirmation verification timeout in milliseconds (default: 75000) */
  confirmationTimeoutMs?: number;
  /** Target job posting URL */
  jobUrl?: string;
}

export interface LiveSubmitResult {
  success: boolean;
  status: ApplicationStatus;
  applicationId: string;
  message?: string;
  proofWebUrl?: string;
  proofCapturedAt?: string;
  proofFailedUrl?: string;
  proofFailedCapturedAt?: string;
  hasEmailProof?: boolean;
  requiresOtp?: boolean;
  errorMessage?: string;
  retryReason?: SubmissionRetryReason;
  summary?: FormFillSummary;
}

export interface PausedSession {
  browser: Browser;
  page: Page;
  browserId?: string;
  otpFieldSelector?: string;
  applicationId: string;
  pausedAt: number;
  jobUrl?: string;
  applywizzId?: string;
  /** Timestamp (ms) when the OTP input was detected */
  otpDetectedAt?: number;
  /** Whether an OTP input field was detected and must be filled to continue */
  requiresOtp?: boolean;
  /** Whether OTP has multiple individual digit/character boxes */
  multiBox?: boolean;
  /** Number of OTP boxes detected if multi-box */
  boxCount?: number;
  /** Array of selectors for each OTP box if multi-box */
  boxSelectors?: string[];
  /** Whether a success or failure screenshot was already captured before closing */
  screenshotCaptured?: boolean;
  /** Auto-close timer handle for the paused OTP session */
  ttlTimer?: NodeJS.Timeout;
}

/**
 * In-memory registry of Playwright browser sessions paused for OTP / verification code resolution.
 * Keyed by applicationId.
 */
export const PAUSED_SESSIONS = new Map<string, PausedSession>();

/**
 * Builds OTP pause metadata from a post-submit field detection result.
 */
export function buildOtpPauseMetadata(
  otpField: OTPFieldDetection
): Pick<
  PausedSession,
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
 * Stores a paused session in PAUSED_SESSIONS with { browser, page, otpFieldSelector, applicationId, pausedAt }.
 * Keyed by applicationId, with secondary aliases for applywizz_id or DB UUID.
 */
export function storePausedSession(
  applicationOrId: ApplicationRow | string,
  session: {
    browser: Browser;
    page: Page;
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

  const existing = PAUSED_SESSIONS.get(canonicalKey);
  if (existing?.ttlTimer) {
    clearTimeout(existing.ttlTimer);
  }

  const ttlTimer = setTimeout(async () => {
    log.warn(
      `[Live Submit] ⏰ Paused OTP session ${canonicalKey} timed out after ${OTP_SESSION_TTL_MS / 60000}m. Closing browser context...`
    );
    await clearPausedSession(canonicalKey);
  }, OTP_SESSION_TTL_MS);

  if (ttlTimer.unref) {
    ttlTimer.unref();
  }

  const fullSession: PausedSession = {
    browser: session.browser,
    page: session.page,
    browserId: session.browserId,
    otpFieldSelector: session.otpFieldSelector,
    applicationId: canonicalKey,
    pausedAt,
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

  PAUSED_SESSIONS.set(canonicalKey, fullSession);
  if (typeof applicationOrId !== 'string' && applicationOrId.id && applicationOrId.id !== canonicalKey) {
    PAUSED_SESSIONS.set(applicationOrId.id, fullSession);
  }
  if (applywizzId && applywizzId !== canonicalKey) {
    PAUSED_SESSIONS.set(applywizzId, fullSession);
  }

  return canonicalKey;
}

/**
 * Resolves a paused session by applicationId, applywizz_id, or any alias key.
 */
export function resolvePausedSession(
  id: string
): { session: PausedSession; canonicalKey: string } | null {
  const cleanId = (id || '').trim();
  if (!cleanId) return null;

  const direct = PAUSED_SESSIONS.get(cleanId);
  if (direct) {
    return { session: direct, canonicalKey: cleanId };
  }

  for (const [key, session] of PAUSED_SESSIONS.entries()) {
    if (session.applicationId === cleanId || session.applywizzId === cleanId) {
      return { session, canonicalKey: key };
    }
  }

  return null;
}

export async function clearPausedSession(
  id: string,
  options: { captureFailureProof?: boolean } = {}
): Promise<void> {
  const resolved = resolvePausedSession(id);
  if (!resolved) return;

  const { session } = resolved;
  if (session.ttlTimer) {
    clearTimeout(session.ttlTimer);
  }
  try {
    if (
      options.captureFailureProof !== false &&
      session.page &&
      !session.page.isClosed() &&
      !session.screenshotCaptured
    ) {
      try {
        await captureFailedScreenshot(session.page, session.applicationId);
        session.screenshotCaptured = true;
      } catch {}
    }
    await session.page?.close().catch(() => {});
    if (session.browserId) {
      await browserManager.releaseBrowser(session.browserId).catch(() => {});
    } else {
      await session.browser?.close().catch(() => {});
    }
  } finally {
    for (const [key, value] of PAUSED_SESSIONS.entries()) {
      if (value === session) {
        PAUSED_SESSIONS.delete(key);
        activeSubmissions.delete(key);
      }
    }
    if (session.applicationId) activeSubmissions.delete(session.applicationId);
    if (session.applywizzId) activeSubmissions.delete(session.applywizzId);
  }
}

const OTP_KEYWORD_PATTERN =
  /otp|verification|verify.?code|one.?time|passcode|\bpin\b|2fa|mfa|auth.?code|security.?code/i;

/** Attribute selectors for common OTP field naming patterns (selector and placeholder patterns). */
const OTP_ATTRIBUTE_SELECTORS = [
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[data-testid*="otp" i]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="verify" i]',
  'input[id*="verify" i]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[name*="passcode" i]',
  'input[id*="passcode" i]',
  'input[name*="pin" i]',
  'input[id*="pin" i]',
  'input[placeholder*="otp" i]',
  'input[placeholder*="8-digit" i]',
  'input[placeholder*="digit" i]',
  'input[placeholder*="verification" i]',
  'input[placeholder*="verify" i]',
  'input[placeholder*="code" i]',
  'input[placeholder*="passcode" i]',
  'input[placeholder*="pin" i]',
  'input[placeholder*="one-time" i]',
  'input[placeholder*="enter code" i]',
  'input[placeholder*="security code" i]',
  'input[aria-label*="otp" i]',
  'input[aria-label*="verification" i]',
  'input[aria-label*="code" i]',
  'input[autocomplete="one-time-code"]',
];

export interface OTPFieldMetadata {
  name?: string;
  id?: string;
  placeholder?: string;
  type?: string;
  inputMode?: string;
  maxLength?: number;
  ariaLabel?: string;
  label?: string;
  autocomplete?: string;
  isNumericOnly?: boolean;
  matchReason?: string;
}

export interface OTPFieldDetection {
  found: boolean;
  selector?: string;
  metadata?: OTPFieldMetadata;
  multiBox?: boolean;
  boxCount?: number;
  boxSelectors?: string[];
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeCssId(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id);
  }
  return id.replace(/([ !"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function buildInputSelector(
  attrs: { id?: string | null; name?: string | null; placeholder?: string | null },
  fallbackSelector: string
): string {
  if (attrs.id) {
    return `#${escapeCssId(attrs.id)}`;
  }
  if (attrs.name) {
    return `input[name="${escapeAttr(attrs.name)}"]`;
  }
  if (attrs.placeholder) {
    return `input[placeholder="${escapeAttr(attrs.placeholder)}"]`;
  }
  return fallbackSelector;
}

async function readOtpFieldMetadata(
  loc: Locator,
  matchReason: string
): Promise<OTPFieldMetadata> {
  const name = (await loc.getAttribute('name')) || undefined;
  const id = (await loc.getAttribute('id')) || undefined;
  const placeholder = (await loc.getAttribute('placeholder')) || undefined;
  const type = ((await loc.getAttribute('type')) || 'text').toLowerCase();
  const inputMode = (await loc.getAttribute('inputmode')) || undefined;
  const maxLengthRaw = await loc.getAttribute('maxlength');
  const parsedMaxLength = maxLengthRaw ? Number.parseInt(maxLengthRaw, 10) : undefined;
  const maxLength =
    parsedMaxLength !== undefined && Number.isFinite(parsedMaxLength) && parsedMaxLength > 0
      ? parsedMaxLength
      : undefined;
  const ariaLabel = (await loc.getAttribute('aria-label')) || undefined;
  const autocomplete = (await loc.getAttribute('autocomplete')) || undefined;
  const pattern = (await loc.getAttribute('pattern')) || undefined;
  const isNumericOnly =
    type === 'tel' ||
    type === 'number' ||
    inputMode === 'numeric' ||
    pattern === '[0-9]*' ||
    pattern === '\\d*';

  return {
    name,
    id,
    placeholder,
    type,
    inputMode,
    maxLength,
    ariaLabel,
    autocomplete,
    isNumericOnly,
    matchReason,
  };
}

async function isVisibleInput(loc: Locator): Promise<boolean> {
  if ((await loc.count()) === 0) {
    return false;
  }
  return loc.isVisible().catch(() => false);
}

/**
 * Scans the page DOM for OTP / verification-code input fields (post-submit).
 * Uses Playwright locators only (no page.evaluate) to avoid tsx __name injection errors.
 */
export async function detectOTPField(page: Page): Promise<OTPFieldDetection> {
  // 1. Check for multiple separate OTP input boxes (e.g. 4 to 8 inputs: data-testid="otp", placeholder="digit", maxlength="1")
  const multiBoxSelectors = [
    'input[data-testid*="otp" i]',
    'input[placeholder*="digit" i]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[aria-label*="digit" i]',
    'input[maxlength="1"]',
  ];

  for (const pattern of multiBoxSelectors) {
    try {
      const locators = page.locator(pattern);
      const count = await locators.count();
      if (count >= 4 && count <= 10) {
        const boxSelectors: string[] = [];
        let allVisible = true;
        for (let i = 0; i < count; i++) {
          const box = locators.nth(i);
          if (await isVisibleInput(box)) {
            const id = await box.getAttribute('id');
            const name = await box.getAttribute('name');
            const placeholder = await box.getAttribute('placeholder');
            boxSelectors.push(
              buildInputSelector({ id, name, placeholder }, `${pattern}:nth-of-type(${i + 1})`)
            );
          } else {
            allVisible = false;
            break;
          }
        }

        if (allVisible && boxSelectors.length >= 4) {
          const firstBox = locators.first();
          const metadata = await readOtpFieldMetadata(
            firstBox,
            `multi-box match: ${count} inputs matching "${pattern}"`
          );
          return {
            found: true,
            selector: boxSelectors[0],
            multiBox: true,
            boxCount: boxSelectors.length,
            boxSelectors,
            metadata,
          };
        }
      }
    } catch {
      // Continue inspecting next multi-box pattern
    }
  }

  // 2. Check for single input matching OTP attribute selectors
  for (const selector of OTP_ATTRIBUTE_SELECTORS) {
    try {
      const loc = page.locator(selector).first();
      if (!(await isVisibleInput(loc))) {
        continue;
      }

      const metadata = await readOtpFieldMetadata(loc, `selector match: ${selector}`);
      const resolvedSelector = buildInputSelector(
        {
          id: metadata.id,
          name: metadata.name,
          placeholder: metadata.placeholder,
        },
        selector
      );

      return { found: true, selector: resolvedSelector, metadata, multiBox: false };
    } catch {
      // Try next selector
    }
  }

  const heuristicSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[inputmode="numeric"]',
    'input[type="text"]',
    'input:not([type])',
  ];

  for (const selector of heuristicSelectors) {
    try {
      const locators = page.locator(selector);
      const count = await locators.count();

      for (let i = 0; i < count; i++) {
        const loc = locators.nth(i);
        if (!(await isVisibleInput(loc))) {
          continue;
        }

        const metadata = await readOtpFieldMetadata(loc, `heuristic match: ${selector}`);
        const combined = `${metadata.name || ''} ${metadata.id || ''} ${metadata.placeholder || ''} ${metadata.ariaLabel || ''}`;

        let matchReason: string | undefined;
        if (OTP_KEYWORD_PATTERN.test(combined)) {
          matchReason = 'keyword match in name/id/placeholder';
        } else if (metadata.autocomplete === 'one-time-code') {
          matchReason = 'autocomplete=one-time-code';
        } else if (
          metadata.isNumericOnly &&
          metadata.maxLength !== undefined &&
          metadata.maxLength <= 8
        ) {
          matchReason = 'numeric-only input with OTP-length constraint';
        }

        if (!matchReason) {
          continue;
        }

        metadata.matchReason = matchReason;
        const resolvedSelector = buildInputSelector(
          {
            id: metadata.id,
            name: metadata.name,
            placeholder: metadata.placeholder,
          },
          selector
        );

        return { found: true, selector: resolvedSelector, metadata };
      }
    } catch {
      // Try next heuristic selector group
    }
  }

  return { found: false };
}

/**
 * Detects form filling and inline validation errors on the page after submission attempt.
 */
export async function detectFormFillingErrors(
  page: Page
): Promise<{ hasError: boolean; message?: string }> {
  try {
    // 1. Check for standard error message elements in DOM
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
      '.field:has(.field__error-text)',
    ];

    for (const sel of errorSelectors) {
      const loc = page.locator(sel);
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 5); i++) {
        const el = loc.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          const text = (await el.innerText().catch(() => '')).trim();
          if (text && text.length > 0 && !/^\s*$/.test(text)) {
            return { hasError: true, message: `Validation error: "${text}"` };
          }
        }
      }
    }

    // 2. Check for HTML5 invalid form inputs that blocked submission.
    //    Exclude aria-hidden="true" inputs — these are hidden backing inputs
    //    for Greenhouse Remix/React-Select comboboxes (class "requiredInput").
    //    They are not real user-facing fields; the combobox fill handles them.
    const invalidInputs = page.locator(
      'input:invalid:not([aria-hidden="true"]):not([tabindex="-1"]), select:invalid, textarea:invalid'
    );
    const invalidCount = await invalidInputs.count().catch(() => 0);
    if (invalidCount > 0) {
      const firstInvalid = invalidInputs.first();
      const info = await firstInvalid.evaluate((el: HTMLElement) => {
        const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const val = input.value || '';
        let labelText = '';
        if (input.id) {
          const l = document.querySelector(`label[for="${input.id}"]`);
          if (l) labelText = (l.textContent || '').trim();
        }
        if (!labelText) {
          const dataField = input.closest('[data-field-id]');
          const l = dataField?.querySelector('label');
          if (l) labelText = (l.textContent || '').trim();
        }
        if (!labelText) {
          const ariaLabelledBy = input.getAttribute('aria-labelledby');
          if (ariaLabelledBy) {
            const ariaEl = document.getElementById(ariaLabelledBy);
            if (ariaEl) labelText = (ariaEl.textContent || '').trim();
          }
        }
        if (!labelText) {
          const parentLabel = input.closest('label');
          if (parentLabel) labelText = (parentLabel.textContent || '').trim();
        }
        if (!labelText) {
          const container = input.closest('.field, .field-wrapper, [class*="field"], .question, tr, div');
          const l = container?.querySelector('label, [class*="label"], .field__label');
          if (l) labelText = (l.textContent || '').trim();
        }
        let optionsArr: string[] = [];
        if (input.tagName === 'SELECT') {
          optionsArr = Array.from((input as HTMLSelectElement).options).map(o => (o.text || '').trim()).filter(Boolean);
        }
        return {
          label: labelText || input.name || input.id || 'unlabeled',
          filled: val,
          options: optionsArr,
        };
      }).catch(() => null);

      const label = info?.label || 'unknown';
      const filled = info?.filled || '';
      const optionsArr = info?.options || [];
      const logMsg = formatInvalidFieldLog(label, filled, optionsArr);
      log.warn(logMsg);
      return { hasError: true, message: logMsg };
    }
  } catch {}

  return { hasError: false };
}





const OTP_VERIFY_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Verify")',
  'button:has-text("Submit")',
  'button:has-text("Confirm")',
  'button:has-text("Continue")',
  'button:has-text("Validate")',
  'button:has-text("Send")',
];

export interface SubmitOtpResult {
  success: boolean;
  status: ApplicationStatus;
  applicationId: string;
  proofUrl?: string;
  proofWebUrl?: string;
  proofCapturedAt?: string;
  proofFailedUrl?: string;
  proofFailedCapturedAt?: string;
  hasEmailProof?: boolean;
  errorMessage?: string;
}

/**
 * Fills a paused OTP prompt, submits verification, and completes the application if confirmed.
 * Supports alphanumeric codes and multiple separate digit/character boxes.
 */
export async function submitOtpToPausedSession(
  applicationId: string,
  otp: string,
  options: { timeoutMs?: number; confirmationTimeoutMs?: number; jobUrl?: string } = {}
): Promise<SubmitOtpResult> {
  const confirmationTimeoutMs =
    options.confirmationTimeoutMs ?? DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS;
  const cleanOtp = (otp || '').trim();

  if (!cleanOtp) {
    throw new Error('OTP value is required.');
  }

  const resolved = resolvePausedSession(applicationId);
  if (!resolved) {
    throw new Error(`No paused session found for application '${applicationId}'.`);
  }

  const { session, canonicalKey } = resolved;
  const application = await getApplication(canonicalKey, options.jobUrl || session.jobUrl);
  if (!application) {
    throw new Error(`Application '${applicationId}' not found.`);
  }

  const { page } = session;

  let otpSelector = session.otpFieldSelector;
  let isMultiBox = session.multiBox || false;
  let boxSelectors = session.boxSelectors || [];

  if (!otpSelector) {
    const detected = await detectOTPField(page);
    if (!detected.found || !detected.selector) {
      if (page && !page.isClosed()) {
        const failed = await captureJobFailedScreenshot(page, application, 'otp_missing_field').catch(() => null);
        if (failed?.url) {
          log.info(`[Live Submit] 📸 OTP missing field failure screenshot URL: ${failed.url}`);
        }
      }
      throw new Error('OTP input field not found on paused session page.');
    }
    otpSelector = detected.selector;
    session.otpFieldSelector = otpSelector;
    session.otpDetectedAt = Date.now();
    session.requiresOtp = true;
    session.multiBox = detected.multiBox;
    session.boxCount = detected.boxCount;
    session.boxSelectors = detected.boxSelectors;
    isMultiBox = Boolean(detected.multiBox);
    boxSelectors = detected.boxSelectors || [];
  }

  log.info(`[Live Submit] 🔢 Submitting OTP for ${canonicalKey} (alphanumeric, multiBox=${isMultiBox})`);

  if (application.id) {
    try {
      await updateStatus(application.id, 'APPLYING');
    } catch (err: any) {
      log.warn(`[Live Submit] ⚠️ Could not set status APPLYING: ${err.message}`);
    }
  }

  try {
    if (isMultiBox && boxSelectors.length > 0) {
      const chars = cleanOtp.split('');
      log.info(
        `[Live Submit] 🔢 Multi-box OTP: filling ${chars.length} characters into ${boxSelectors.length} boxes...`
      );
      for (let i = 0; i < Math.min(chars.length, boxSelectors.length); i++) {
        const boxSel = boxSelectors[i];
        const box = page.locator(boxSel).first();
        await box.waitFor({ state: 'visible', timeout: 5000 });
        await box.fill(chars[i], { timeout: 5000 });
      }
    } else {
      const otpInput = page.locator(otpSelector).first();
      await otpInput.waitFor({ state: 'visible', timeout: 5000 });
      await otpInput.fill(cleanOtp, { timeout: 5000 });
    }

    let verifyClicked = false;
    for (const sel of OTP_VERIFY_SELECTORS) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        log.info(`[Live Submit] 🖱️ Clicking OTP verify button (${sel})...`);
        await btn.click({ timeout: 5000 });
        verifyClicked = true;
        break;
      }
    }

    if (!verifyClicked) {
      log.info('[Live Submit] ↩️ No OTP verify button found — pressing Enter on OTP field.');
      if (isMultiBox && boxSelectors.length > 0) {
        const lastBox = page.locator(boxSelectors[boxSelectors.length - 1]).first();
        await lastBox.press('Enter').catch(() => {});
      } else {
        const otpInput = page.locator(otpSelector).first();
        await otpInput.press('Enter').catch(() => {});
      }
    }

    log.info(`[Live Submit] ⏳ Waiting up to ${confirmationTimeoutMs / 1000}s for confirmation after OTP...`);
    const verification = await verifySubmissionSignals(page, confirmationTimeoutMs);

    if (verification.verified) {
      log.info(`[Live Submit] 🎉 OTP verification confirmed! Signal: ${verification.signal}`);

      const proofResult = await captureWebProof(page, application);
      session.screenshotCaptured = true;
      if (proofResult.proofWebUrl) {
        log.info(`[Live Submit] 📸 Success web proof screenshot URL: ${proofResult.proofWebUrl}`);
      }

      const targetAppId = application.id || canonicalKey;
      const submittedAt = new Date().toISOString();
      await updateStatus(targetAppId, 'EMAIL_PROOF_PENDING', {
        proof_web_url: proofResult.proofWebUrl,
        proof_captured_at: proofResult.proofCapturedAt,
        job_url: application.job_url,
      }).catch((err: any) => {
        log.warn(`[Live Submit] ⚠️ Could not set status EMAIL_PROOF_PENDING: ${err.message}`);
      });

      await closeSubmissionSession(canonicalKey);
      await clearPausedSession(canonicalKey);

      // Attempt immediate confirmation email verification (up to 15s)
      log.info(`[Live Submit] 📧 Checking for immediate confirmation email after OTP...`);
      const emailProof = await captureAndSaveEmailProof(application, {
        timeoutMs: 15000,
      }).catch(() => null);

      if (emailProof) {
        log.info(`[Live Submit] 🎉 Confirmation email verified immediately after OTP! Marking APPLIED.`);
        await updateStatus(targetAppId, 'APPLIED', {
          proof_web_url: proofResult.proofWebUrl,
          proof_captured_at: proofResult.proofCapturedAt,
          proof_email_json: emailProof,
          proof_email_captured_at: emailProof.received_at || new Date().toISOString(),
          email_proof_status: 'captured',
          job_url: application.job_url,
        }).catch((err: any) => {
          log.warn(`[Live Submit] ⚠️ Could not set status APPLIED: ${err.message}`);
        });

        return {
          success: true,
          status: 'APPLIED',
          applicationId: canonicalKey,
          proofUrl: proofResult.proofWebUrl,
          proofWebUrl: proofResult.proofWebUrl,
          proofCapturedAt: proofResult.proofCapturedAt,
          hasEmailProof: true,
        };
      }

      // Zero matches on immediate check: transition to EMAIL_PROOF_PENDING & start 30s background retry
      log.info(
        `[Live Submit] ⏳ Confirmation email not found immediately after OTP. Retrying in background every 30s for up to 10m (EMAIL_PROOF_PENDING)...`
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
        applicationId: canonicalKey,
        proofUrl: proofResult.proofWebUrl,
        proofWebUrl: proofResult.proofWebUrl,
        proofCapturedAt: proofResult.proofCapturedAt,
      };
    }

    const isTimeout = /time.*out/i.test(verification.error || '');
    const errorMsg = isTimeout
      ? `Timeout: OTP confirmation timed out after ${confirmationTimeoutMs}ms.`
      : (verification.error || 'OTP submission verification failed.');

    if (isTimeout) {
      log.warn(`[Live Submit] ⏱️ Timeout: OTP verification timed out for application ${canonicalKey}`);
    } else {
      log.warn(`[Live Submit] ❌ OTP submission verification failed: ${errorMsg}`);
    }

    let failedProofUrl: string | undefined;
    let failedCapturedAt: string | undefined;
    // Capture failure screenshot on verification failure
    if (page && !page.isClosed()) {
      const failed = await captureFailedScreenshot(page, application).catch(() => null);
      if (failed?.url) {
        log.info(`[Live Submit] 📸 OTP verification failure screenshot URL: ${failed.url}`);
        failedProofUrl = failed.proofFailedUrl || failed.url;
        failedCapturedAt = failed.proofFailedCapturedAt || failed.capturedAt;
      }
    }

    // Critical: on verification failure or timeout, keep session paused for retry!
    if (application.id) {
      try {
        await updateStatus(application.id, 'OTP_REQUIRED', {
          error_message: errorMsg,
          proof_failed_url: failedProofUrl,
          proof_failed_captured_at: failedCapturedAt,
          job_url: application.job_url,
        });
      } catch {}
    }

    return {
      success: false,
      status: 'FAILED',
      applicationId: canonicalKey,
      errorMessage: errorMsg,
      proofFailedUrl: failedProofUrl,
      proofFailedCapturedAt: failedCapturedAt,
    };
  } catch (err: any) {
    const isTimeout = /time.*out/i.test(err.message || '');
    const errorMsg = isTimeout
      ? 'Timeout: OTP was not filled in time.'
      : (err.message || 'Error occurred during OTP submission.');

    if (isTimeout) {
      log.warn(`[Live Submit] ⏱️ Timeout: OTP submission timed out for ${canonicalKey}`);
    } else {
      log.error(`[Live Submit] ❌ OTP submit error for ${canonicalKey}:`, err);
    }

    let errProofUrl: string | undefined;
    let errCapturedAt: string | undefined;
    if (page && !page.isClosed()) {
      const failed = await captureFailedScreenshot(page, application).catch(() => null);
      if (failed?.url) {
        log.info(`[Live Submit] 📸 OTP submit error failure screenshot URL: ${failed.url}`);
        errProofUrl = failed.proofFailedUrl || failed.url;
        errCapturedAt = failed.proofFailedCapturedAt || failed.capturedAt;
      }
    }

    if (application.id) {
      try {
        await updateStatus(application.id, 'OTP_REQUIRED', {
          error_message: errorMsg,
          proof_failed_url: errProofUrl,
          proof_failed_captured_at: errCapturedAt,
          job_url: application.job_url,
        });
      } catch {}
    }

    return {
      success: false,
      status: 'FAILED',
      applicationId: canonicalKey,
      errorMessage: errorMsg,
      proofFailedUrl: errProofUrl,
      proofFailedCapturedAt: errCapturedAt,
    };
  }
}

/**
 * Runs a live automated submission for a candidate job application.
 *
 * @param applicationOrId - Application DB record or UUID string
 * @param options - Configuration overrides for browser and jitter
 * @returns Result with updated status and proof URL if successful
 */
export async function runLiveSubmit(
  applicationOrId: string | ApplicationRow,
  options: LiveSubmitOptions = {}
): Promise<LiveSubmitResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const confirmationTimeoutMs =
    options.confirmationTimeoutMs ?? DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS;

  // 1. Resolve application record
  let application: ApplicationRow;
  if (typeof applicationOrId === 'string') {
    const fetched = await getApplication(applicationOrId, options.jobUrl);
    if (!fetched) {
      throw new Error(`Application record with ID '${applicationOrId}' not found.`);
    }
    application = fetched;
  } else {
    application = applicationOrId;
  }

  assertWithinSubmissionQuestionLimit(application);

  // Ensure a persistent DB record exists so proof screenshots can be attached
  if (!application.id) {
    try {
      const upserted = await upsertApplication({
        applywizz_id: application.applywizz_id,
        job_url: application.job_url,
        company_name: application.company_name,
        job_title: application.job_title,
        resolved_fields: application.resolved_fields || [],
        status: application.status || 'READY_FOR_REVIEW',
      });
      application = { ...application, ...upserted };
    } catch (err: any) {
      log.warn(`[Live Submit] ⚠️ Could not upsert application record before submit: ${err.message}`);
    }
  }

  const applicationId = application.id || application.applywizz_id || 'live-submit-app';
  const targetUrl = application.job_url;

  if (!targetUrl) {
    throw new Error(`Application ${applicationId} has no job_url specified.`);
  }

  if (!(await ensureResumeAvailable(application))) {
    const errorMessage = 'Resume unavailable — could not fetch from ApplyWizz';
    await emitFailureDiagnostic({
      category: 'SUBMIT_RESUME_MISSING',
      stage: 'resume_preparation',
      reason: errorMessage,
      applicationId: application.id || applicationId,
      applywizzId: application.applywizz_id,
      jobUrl: targetUrl,
      isTerminal: true,
      isRetryable: false,
    }).catch(() => {});
    if (application.id) {
      await updateStatus(application.id, 'FAILED', {
        error_message: errorMessage,
        job_url: application.job_url,
      }).catch(() => {});
    }
    return {
      success: false,
      status: 'FAILED',
      applicationId,
      errorMessage,
    };
  }

  const isHeadless = process.env.RAILWAY_ENV === 'true' ? true : (options.headless ?? true);
  log.info(
    `[Live Submit] 🚀 Initiating live submission for ${application.applywizz_id} [${targetUrl}] (headless: ${isHeadless})...`
  );

  // Update DB status to APPLYING
  if (application.id) {
    try {
      await updateStatus(application.id, 'APPLYING');
    } catch (err: any) {
      log.warn(`[Live Submit] ⚠️ Could not set status APPLYING: ${err.message}`);
    }
  }

  let managedBrowser: ManagedBrowser | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let fillSummary: FormFillSummary | undefined;
  let keepSessionOpen = false;
  let screenshotCaptured = false;

  try {
    // 2. Launch browser with anti-detection flags (strictly headless on Railway; headful supported locally)
    try {
      managedBrowser = await browserManager.acquireBrowser({
        headless: isHeadless,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      browser = managedBrowser.browser;
    } catch (launchErr: any) {
      const launchErrMsg = `Browser launch failed: ${launchErr?.message || String(launchErr)}`;
      log.error(`[Live Submit] ❌ ${launchErrMsg}`);
      await emitFailureDiagnostic({
        category: 'SUBMIT_PLAYWRIGHT_LAUNCH',
        stage: 'browser_launch',
        reason: launchErrMsg,
        error: launchErr,
        isTerminal: false,
        isRetryable: true,
        applicationId: application.id || applicationId,
        jobUrl: targetUrl,
      });

      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: launchErrMsg,
          job_url: application.job_url,
        }).catch(() => {});
      }

      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: launchErrMsg,
        retryReason: 'BROWSER_LAUNCH_FAILED',
      };
    }

    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    page = await context.newPage();

    // 3. Navigate to the job application URL
    log.info(`[Live Submit] 🌐 Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Capture screenshot after navigating to job URL, before filling form
    try {
      const openResult = await captureJobOpenScreenshot(page, application);
      if (openResult.url) {
        log.info(`[Live Submit] 📸 Job open screenshot URL: ${openResult.url}`);
      }
    } catch (openErr: any) {
      log.warn(`[Live Submit] ⚠️ Could not capture job open screenshot: ${openErr.message}`);
    }

    // 4. Fill all form fields
    try {
      const freshApplication = await getApplication(applicationId, options.jobUrl || targetUrl);
      if (freshApplication) {
        application = freshApplication;
      }
      fillSummary = await fillForm(page, application, {
        minJitterMs: options.minJitterMs ?? 300,
        maxJitterMs: options.maxJitterMs ?? 800,
        timeoutMs: 5000,
      });
    } catch (fillErr: any) {
      const fillErrMsg = `Form filling error: ${fillErr.message || 'Failed to populate application fields.'}`;
      log.error(`[Live Submit] ❌ ${fillErrMsg} for application ${applicationId}`);
      let failedProof: any = null;
      if (page && !page.isClosed()) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
        if (failedProof?.url) {
          log.info(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
        }
        screenshotCaptured = true;
      }
      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: fillErrMsg,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        }).catch(() => {});
      }
      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: fillErrMsg,
        summary: fillSummary,
        proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
        proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
      };
    }

    const unfilledRequiredLabels = fillSummary.results
      .filter(
        (result) =>
          result.isRequired === true &&
          (!result.valuePopulated || result.source === 'unresolved')
      )
      .map((result) => result.label);

    if (unfilledRequiredLabels.length > 0) {
      const requiredFieldsError = `Required fields not filled: ${unfilledRequiredLabels.join(', ')}`;
      log.error(`[Live Submit] ❌ ${requiredFieldsError} for application ${applicationId}`);
      await emitFailureDiagnostic({
        category: 'SUBMIT_REQUIRED_FIELD_EMPTY',
        stage: 'form_validation',
        reason: requiredFieldsError,
        applicationId: application.id || applicationId,
        applywizzId: application.applywizz_id,
        jobUrl: targetUrl,
        isTerminal: false,
        isRetryable: true,
      }).catch(() => {});
      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: requiredFieldsError,
          job_url: application.job_url,
        }).catch(() => {});
      }
      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: requiredFieldsError,
        retryReason: 'UNRESOLVED_REQUIRED_FIELD',
        summary: fillSummary,
      };
    }

    // 5. Locate and click form submit button
    const preSubmitUrl = page.url();

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '#submit_app',
      'button:has-text("Submit Application")',
      'input[value*="Submit"]',
      'button:has-text("Apply")',
      '#submit_application',
    ];

    let submitClicked = false;
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        log.info(`[Live Submit] 🖱️ Clicking submit button (${sel})...`);
        await btn.click({ timeout: 5000 });
        submitClicked = true;
        break;
      }
    }

    if (!submitClicked) {
      const fillErrMsg = 'Form filling error: Submit button could not be located on the application form.';
      log.error(`[Live Submit] ❌ ${fillErrMsg} for application ${applicationId}`);
      await emitFailureDiagnostic({
        category: 'SUBMIT_FORM_FILL_ERROR',
        stage: 'submit_button_click',
        reason: fillErrMsg,
        isTerminal: false,
        isRetryable: true,
        applicationId: application.id || applicationId,
        jobUrl: targetUrl,
      });
      let failedProof: any = null;
      if (page && !page.isClosed()) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
        if (failedProof?.url) {
          log.info(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
        }
        screenshotCaptured = true;
      }
      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: fillErrMsg,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        }).catch(() => {});
      }
      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: fillErrMsg,
        summary: fillSummary,
        proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
        proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
      };
    }

    // Capture screenshot immediately after clicking submit button (before detecting block)
    try {
      const submittedResult = await captureJobSubmittedScreenshot(page, application);
      if (submittedResult.url) {
        log.info(`[Live Submit] 📸 Job submitted screenshot URL: ${submittedResult.url}`);
      }
    } catch (subErr: any) {
      log.warn(`[Live Submit] ⚠️ Could not capture job submitted screenshot: ${subErr.message}`);
    }

    // 6. Wait 2-3 seconds for page to respond after submit click
    log.info('[Live Submit] ⏳ Waiting 2-3s for page response post-submit...');
    await page.waitForTimeout(2500);

    const currentUrl = page.url();
    const urlChanged =
      currentUrl !== preSubmitUrl &&
      currentUrl.replace(/#.*$/, '') !== preSubmitUrl.replace(/#.*$/, '');

    const pageText = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();

    // Check if page responded successfully (URL changed or confirmation indicators)
    const hasSuccessIndicators =
      urlChanged ||
      /confirmation|applied|submitted|jobs\/[a-z0-9_-]+\/applied/i.test(currentUrl) ||
      /thank you for applying|thanks for applying|your application has been submitted|application received|we have received your application|application submitted|track your application/i.test(
        pageText
      );

    if (hasSuccessIndicators) {
      log.info(
        `[Live Submit] 🚀 Submission responded successfully (urlChanged=${urlChanged}, url=${currentUrl}). Continuing to confirmation verification...`
      );
    } else {
      // Check for OTP field requirement
      const otpField = await detectOTPField(page);
      if (otpField.found) {
        log.warn(
          `[Live Submit] 🔢 OTP input detected post-submit (${otpField.selector})` +
            `${otpField.metadata?.type ? ` [type=${otpField.metadata.type}]` : ''}` +
            `${otpField.metadata?.matchReason ? ` — ${otpField.metadata.matchReason}` : ''}`
        );

        // Capture OTP challenge modal screenshot before pausing
        await captureJobOtpScreenshot(page, application).catch(() => null);

        if (application.id) {
          try {
            await updateStatus(application.id, 'OTP_REQUIRED');
          } catch (err: any) {
            log.warn(`[Live Submit] ⚠️ Could not set status OTP_REQUIRED: ${err.message}`);
          }
        }

        const pausedAt = Date.now();
        const sessionKey = storePausedSession(application, {
          browser,
          page,
          browserId: managedBrowser?.browserId,
          otpFieldSelector: otpField.selector,
          applicationId,
          pausedAt,
          jobUrl: targetUrl,
          ...buildOtpPauseMetadata(otpField),
        });

        registerSubmissionSession({
          applicationId: sessionKey,
          browser,
          context,
          page,
          application,
          startedAt: pausedAt,
        });

        keepSessionOpen = true;

        let companyEmail: string | null = null;
        try {
          const profile = await getProfile(application.applywizz_id);
          if (profile) {
            companyEmail = (profile.company_email || profile.email || '').trim() || null;
          }
        } catch (profErr: any) {
          log.warn(`[Live Submit] ⚠️ Could not fetch profile for company email: ${profErr.message}`);
        }

        if (companyEmail) {
          otpResolutionService.register({
            applicationId,
            email: companyEmail,
            submitClickedAt: pausedAt,
            sessionKey,
          });
        } else {
          log.warn(`[Live Submit] ⚠️ No company email found for application ${applicationId}; skipping OTP registration.`);
        }
        return {
          success: false,
          status: 'OTP_REQUIRED',
          applicationId,
          requiresOtp: true,
          summary: fillSummary,
        };
      }

      // Check for form filling / validation errors on page
      const fillError = await detectFormFillingErrors(page);
      if (fillError.hasError) {
        const fillErrMsg = `Form filling error: ${fillError.message}`;
        log.error(`[Live Submit] ❌ ${fillErrMsg} for application ${applicationId}`);
        await emitFailureDiagnostic({
          category: 'SUBMIT_FORM_FILL_ERROR',
          stage: 'form_filling',
          reason: fillErrMsg,
          isTerminal: false,
          isRetryable: true,
          applicationId: application.id || applicationId,
          jobUrl: targetUrl,
        });
        let failedProof: any = null;
        if (page && !page.isClosed()) {
          failedProof = await captureFailedScreenshot(page, application).catch(() => null);
          if (failedProof?.url) {
            log.info(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
          }
          screenshotCaptured = true;
        }
        if (application.id) {
          await updateStatus(application.id, 'FAILED', {
            error_message: fillErrMsg,
            proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
            proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
            job_url: application.job_url,
          }).catch(() => {});
        }
        return {
          success: false,
          status: 'FAILED',
          applicationId,
          errorMessage: fillErrMsg,
          retryReason: /Required field validation failed/i.test(fillErrMsg)
            ? 'UNRESOLVED_REQUIRED_FIELD'
            : undefined,
          summary: fillSummary,
          proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
          proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
        };
      }
    }

    // 7. Multi-Signal Completion Verification
    log.info(
      `[Live Submit] ⏳ Waiting up to ${confirmationTimeoutMs / 1000}s for submission confirmation signals...`
    );
    const verification = await verifySubmissionSignals(page, confirmationTimeoutMs);

    if (verification.verified) {
      log.info(`[Live Submit] 🎉 Submission verified! Signal: ${verification.signal}`);

      // 8. Capture full-page proof screenshot & attach to application (like dry-run)
      let proofResult: { proofWebUrl?: string; proofCapturedAt?: string } = {};
      try {
        proofResult = await captureWebProof(page, application);
        screenshotCaptured = true;
      } catch (err: any) {
        log.warn(`[liveSubmit] Proof capture failed after submit — marking APPLIED anyway: ${err.message}`);
        await emitFailureDiagnostic({
          category: 'SUBMIT_PROOF_CAPTURE',
          stage: 'proof_capture',
          reason: `Web proof screenshot capture failed: ${err?.message || String(err)}`,
          error: err,
          applicationId: application.id || applicationId,
          applywizzId: application.applywizz_id,
          jobUrl: targetUrl,
          isTerminal: false,
          isRetryable: true,
        }).catch(() => {});
      }
      if (proofResult.proofWebUrl) {
        log.info(`[Live Submit] 📸 Success web proof screenshot URL: ${proofResult.proofWebUrl}`);
      }

      // 9. Attach web proof & set submission timestamp
      const submittedAt = new Date().toISOString();
      const targetAppId = application.id || applicationId;
      await updateStatus(targetAppId, 'EMAIL_PROOF_PENDING', {
        proof_web_url: proofResult.proofWebUrl,
        proof_captured_at: proofResult.proofCapturedAt,
        job_url: application.job_url,
      });

      // 10. Attempt immediate email confirmation check (up to 15s)
      log.info(`[Live Submit] 📧 Checking for immediate confirmation email matching company & apply time...`);
      const emailProof = await captureAndSaveEmailProof(application, {
        timeoutMs: 15000,
      }).catch(() => null);

      if (emailProof) {
        log.info(`[Live Submit] 🎉 Confirmation email verified immediately! Marking APPLIED.`);
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
          hasEmailProof: true,
          summary: fillSummary,
        };
      }

      // Zero matches on immediate check: transition to EMAIL_PROOF_PENDING & start 30s background retry
      log.info(
        `[Live Submit] ⏳ Confirmation email not found immediately. Retrying in background every 30s for up to 10m (EMAIL_PROOF_PENDING)...`
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
        summary: fillSummary,
      };
    } else {
      const isServerError = (verification.error || '').startsWith('GREENHOUSE_SERVER_ERROR:');
      const isTimeout = !isServerError && /time.*out/i.test(verification.error || '');
      const isFormError = !isServerError && /form (filling|validation) error/i.test(verification.error || '');
      let errorMsg: string;

      if (isServerError) {
        const details = (verification.error || '').replace(/^GREENHOUSE_SERVER_ERROR:\s*/, '');
        errorMsg = `Greenhouse server error: ${details}`;
        log.error(`[Live Submit] ❌ ${errorMsg} for application ${applicationId}`);
      } else if (isFormError) {
        errorMsg = verification.error || 'Form filling error: Validation failed.';
        log.error(`[Live Submit] ❌ ${errorMsg} for application ${applicationId}`);
      } else if (isTimeout) {
        errorMsg = `Timeout: Submission verification timed out after ${confirmationTimeoutMs}ms.`;
        log.warn(`[Live Submit] ⏱️ Timeout: ${errorMsg} for application ${applicationId}`);
      } else {
        errorMsg = verification.error || 'Submission verification failed.';
        log.warn(`[Live Submit] ❌ Submission verification failed: ${errorMsg} for application ${applicationId}`);
      }

      await emitFailureDiagnostic({
        category: isServerError || isFormError
          ? 'SUBMIT_FORM_FILL_ERROR'
          : 'SUBMIT_CONFIRMATION_TIMEOUT',
        stage: 'submission_confirmation',
        reason: errorMsg,
        isTerminal: false,
        isRetryable: isServerError ? true : !isTimeout,
        applicationId: application.id || applicationId,
        jobUrl: targetUrl,
        metadata: { timeoutMs: confirmationTimeoutMs },
      });

      let failedProof: any = null;
      let errorDiagnostics: any = null;
      if (page && !page.isClosed()) {
        errorDiagnostics = await captureFailureDiagnostics(page).catch(() => null);
        if (!screenshotCaptured) {
          failedProof = await captureFailedScreenshot(page, application).catch(() => null);
          if (failedProof?.url) {
            log.info(`[Live Submit] 📸 Submission verification failure screenshot URL: ${failedProof.url}`);
          }
          screenshotCaptured = true;
        }
      }

      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: errorMsg,
          error_details: errorDiagnostics,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        }).catch(() => {});
      }

      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: errorMsg,
        retryReason: isFormError && /Required field validation failed/i.test(errorMsg)
          ? 'UNRESOLVED_REQUIRED_FIELD'
          : undefined,
        summary: fillSummary,
        proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
        proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
      };
    }
  } catch (err: any) {
    const isTimeout = /time.*out/i.test(err.message || '');
    const isFillError = /form filling error|fillSingleField|fillForm/i.test(err.message || '');
    let finalErrMsg = err.message || 'Submission execution failed.';

    if (isFillError) {
      finalErrMsg = `Form filling error: ${err.message}`;
      log.error(`[Live Submit] ❌ ${finalErrMsg} for application ${applicationId}`);
    } else if (isTimeout) {
      finalErrMsg = `Timeout: ${err.message}`;
      log.warn(`[Live Submit] ⏱️ Timeout: ${finalErrMsg} for application ${applicationId}`);
    } else {
      log.error(`[Live Submit] ❌ Submission execution error for application ${applicationId}: ${finalErrMsg}`);
    }

    await emitFailureDiagnostic({
      category: isFillError
        ? 'SUBMIT_FORM_FILL_ERROR'
        : isTimeout
          ? 'SUBMIT_PLAYWRIGHT_TIMEOUT'
          : 'SUBMIT_PLAYWRIGHT_NAVIGATE',
      stage: 'submission_execution',
      reason: finalErrMsg,
      error: err,
      isTerminal: false,
      isRetryable: true,
      applicationId: application.id || applicationId,
      jobUrl: targetUrl,
    });

    let failedProof: any = null;
    let errorDiagnostics: any = null;
    if (page && !page.isClosed()) {
      errorDiagnostics = await captureFailureDiagnostics(page).catch(() => null);
      if (!screenshotCaptured) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
        if (failedProof?.url) {
          log.info(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
        }
        screenshotCaptured = true;
      }
    }

    if (application.id) {
      try {
        await updateStatus(application.id, 'FAILED', {
          error_message: finalErrMsg,
          error_details: errorDiagnostics,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        });
      } catch {}
    }

    return {
      success: false,
      status: 'FAILED',
      applicationId,
      errorMessage: finalErrMsg,
      summary: fillSummary,
      proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
      proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
    };
  } finally {
    if (!keepSessionOpen) {
      if (page && !page.isClosed() && !screenshotCaptured) {
        try {
          log.info(`[Live Submit] 📸 Capturing failure screenshot before closing browser for ${applicationId}...`);
          const failed = await captureFailedScreenshot(page, application);
          if (failed?.url) {
            log.info(`[Live Submit] 📸 Pre-close failure screenshot URL: ${failed.url}`);
            const targetAppId = application.id || application.applywizz_id;
            if (targetAppId) {
              const preCloseDiag = await captureFailureDiagnostics(page).catch(() => null);
              await updateStatus(targetAppId, 'FAILED', {
                error_details: preCloseDiag,
                proof_failed_url: failed.proofFailedUrl || failed.url,
                proof_failed_captured_at: failed.proofFailedCapturedAt || failed.capturedAt,
                job_url: application.job_url,
              }).catch(() => {});
            }
          }
        } catch (preCloseErr: any) {
          log.warn(`[Live Submit] ⚠️ Pre-close screenshot failed: ${preCloseErr.message}`);
        }
      }
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (managedBrowser) {
        await browserManager.releaseBrowser(managedBrowser.browserId).catch(() => {});
      } else if (browser) {
        await browser.close().catch(() => {});
      }
      log.info(`[Live Submit] 🏁 Closed browser context for application ${applicationId}.`);
    } else {
      log.debug(
        `[Live Submit] ⏸️ Browser context kept paused in memory for application ${applicationId}.`
      );
    }
  }
}

export default runLiveSubmit;
