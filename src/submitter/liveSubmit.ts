/**
 * @fileoverview Playwright Live Submission Engine with post-submit CAPTCHA/OTP detection (Phase V2-4).
 *
 * Executes automated Greenhouse form submission:
 * 1. Launches isolated Playwright browser context
 * 2. Populates form via formFiller.ts
 * 3. Clicks the submit button
 * 4. Inspects for CAPTCHA iframes or OTP input fields (post-submit only)
 *    - If detected: transitions status to OTP_REQUIRED and registers paused session
 * 5. Runs 30-second multi-signal completion verification (Title / DOM tokens / URL)
 * 6. On confirmation: captures full-page web proof, uploads to Supabase Storage, sets status APPLIED
 * 7. On timeout / failure: captures error details, sets status FAILED
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { fillForm, type FormFillSummary, type FormFillerOptions } from './formFiller.js';
import {
  captureWebProof,
  captureFailedScreenshot,
  captureJobOpenScreenshot,
  captureJobSubmittedScreenshot,
  captureAndSaveEmailProof,
} from './proofCapture.js';
import { emailProofPoller } from './emailProofPoller.js';
import {
  registerSubmissionSession,
  verifySubmissionSignals,
  closeSubmissionSession,
} from './captchaResume.js';

export { verifySubmissionSignals };
import {
  getApplication,
  updateStatus,
  upsertApplication,
  type ApplicationRow,
  type ApplicationStatus,
} from '../db/applications.js';
import { getProfile, getCompanyEmail } from '../db/profiles.js';
import { zohoReader } from '../services/zohoReader.js';
import { config } from '../config/env.js';

export interface LiveSubmitOptions extends FormFillerOptions {
  /** Launch in headless mode (default: true) */
  headless?: boolean;
  /** Navigation and submission timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Target job posting URL */
  jobUrl?: string;
  /** Optional timeout specifically for CAPTCHA resolution polling (default: 300000 = 5 min) */
  captchaTimeoutMs?: number;
  /** Whether to automatically poll for CAPTCHA resolution upon headful switch (default: true) */
  autoPollCaptcha?: boolean;
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
  requiresOtp?: boolean;
  /** @deprecated Use requiresOtp */
  requiresCaptcha?: boolean;
  challengeType?: 'otp' | 'captcha';
  errorMessage?: string;
  summary?: FormFillSummary;
}

export interface PausedSession {
  browser: Browser;
  page: Page;
  otpFieldSelector?: string;
  applicationId: string;
  pausedAt: number;
  jobUrl?: string;
  applywizzId?: string;
  /** Timestamp (ms) when the OTP input was detected */
  otpDetectedAt?: number;
  /** Whether an OTP input field was detected and must be filled to continue */
  requiresOtp?: boolean;
  challengeType?: 'otp' | 'captcha';
  /** Timestamp (ms) when switched to headful mode for CAPTCHA solving */
  appliedHeadfulAt?: number;
  /** Whether OTP has multiple individual digit/character boxes */
  multiBox?: boolean;
  /** Number of OTP boxes detected if multi-box */
  boxCount?: number;
  /** Array of selectors for each OTP box if multi-box */
  boxSelectors?: string[];
  /** Whether a success or failure screenshot was already captured before closing */
  screenshotCaptured?: boolean;
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
  | 'challengeType'
  | 'multiBox'
  | 'boxCount'
  | 'boxSelectors'
> {
  if (otpField.found && otpField.selector) {
    return {
      otpFieldSelector: otpField.selector,
      otpDetectedAt: Date.now(),
      requiresOtp: true,
      challengeType: 'otp',
      multiBox: otpField.multiBox,
      boxCount: otpField.boxCount,
      boxSelectors: otpField.boxSelectors,
    };
  }

  return {
    requiresOtp: false,
    challengeType: 'captcha',
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
    applicationId?: string;
    otpFieldSelector?: string;
    pausedAt?: number;
    jobUrl?: string;
    applywizzId?: string;
    otpDetectedAt?: number;
    requiresOtp?: boolean;
    challengeType?: 'otp' | 'captcha';
    appliedHeadfulAt?: number;
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

  const fullSession: PausedSession = {
    browser: session.browser,
    page: session.page,
    otpFieldSelector: session.otpFieldSelector,
    applicationId: canonicalKey,
    pausedAt,
    jobUrl,
    applywizzId,
    otpDetectedAt: session.otpDetectedAt ?? pausedAt,
    requiresOtp: session.requiresOtp ?? Boolean(session.otpFieldSelector),
    challengeType: session.challengeType ?? (session.otpFieldSelector ? 'otp' : 'captcha'),
    appliedHeadfulAt: session.appliedHeadfulAt,
    multiBox: session.multiBox,
    boxCount: session.boxCount,
    boxSelectors: session.boxSelectors,
    screenshotCaptured: session.screenshotCaptured ?? false,
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

/**
 * Removes all alias keys for a paused session and closes the browser.
 */
export async function clearPausedSession(id: string): Promise<void> {
  const resolved = resolvePausedSession(id);
  if (!resolved) return;

  const { session } = resolved;
  try {
    if (session.page && !session.page.isClosed() && !session.screenshotCaptured) {
      try {
        await captureFailedScreenshot(session.page, session.applicationId);
        session.screenshotCaptured = true;
      } catch {}
    }
    await session.page.close().catch(() => {});
    await session.browser.close().catch(() => {});
  } finally {
    for (const [key, value] of PAUSED_SESSIONS.entries()) {
      if (value === session) {
        PAUSED_SESSIONS.delete(key);
      }
    }
  }
}

/**
 * Known CAPTCHA iframe and element selector patterns.
 */
const CAPTCHA_SELECTORS = [
  'iframe[src*="turnstile"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'div.cf-turnstile',
  'iframe[src*="recaptcha"]',
  'iframe[title*="reCAPTCHA"]',
  'div.g-recaptcha',
  'iframe[src*="hcaptcha"]',
  'div.h-captcha',
  'iframe[src*="arkoselabs"]',
  '[data-sitekey]',
];

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
 * Checks if the page contains an active CAPTCHA iframe challenge.
 */
export async function detectCaptchaIframe(
  page: Page
): Promise<{ detected: boolean; type?: string }> {
  for (const selector of CAPTCHA_SELECTORS) {
    try {
      const loc = page.locator(selector).first();
      const count = await loc.count();
      if (count > 0 && (await loc.isVisible().catch(() => true))) {
        return { detected: true, type: `captcha: ${selector}` };
      }
    } catch {
      // Continue inspecting other selectors
    }
  }

  const frames = page.frames();
  for (const frame of frames) {
    const frameUrl = frame.url().toLowerCase();
    if (
      frameUrl.includes('turnstile') ||
      frameUrl.includes('recaptcha') ||
      frameUrl.includes('hcaptcha') ||
      frameUrl.includes('challenges.cloudflare.com')
    ) {
      return { detected: true, type: `frame: ${frameUrl}` };
    }
  }

  return { detected: false };
}

export const detectCaptchaWidgets = detectCaptchaIframe;

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
      '.errors',
      '.error-message',
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

    // 2. Check for HTML5 invalid form inputs that blocked submission
    const invalidInputs = page.locator('input:invalid, select:invalid, textarea:invalid');
    const invalidCount = await invalidInputs.count().catch(() => 0);
    if (invalidCount > 0) {
      const firstInvalid = invalidInputs.first();
      const validationMsg = await firstInvalid.evaluate(
        (el: HTMLInputElement) => el.validationMessage || ''
      ).catch(() => '');
      const fieldName =
        (await firstInvalid.getAttribute('name').catch(() => '')) ||
        (await firstInvalid.getAttribute('id').catch(() => '')) ||
        'required field';
      const detail = validationMsg ? `${fieldName} (${validationMsg})` : `${fieldName} is invalid or required`;
      return { hasError: true, message: `Required field validation failed: ${detail}` };
    }
  } catch {}

  return { hasError: false };
}

/**
 * Checks if the page contains an active CAPTCHA challenge or OTP verification prompt.
 */
export async function detectCaptchaOrOtp(
  page: Page
): Promise<{ detected: boolean; type?: string; otpField?: OTPFieldDetection }> {
  const otpField = await detectOTPField(page);
  if (otpField.found) {
    return {
      detected: true,
      type: `otp: ${otpField.selector}`,
      otpField,
    };
  }

  const captcha = await detectCaptchaIframe(page);
  if (captcha.detected) {
    return { detected: true, type: captcha.type };
  }

  return { detected: false, otpField };
}

/** @deprecated Use detectCaptchaOrOtp */
export const detectCaptcha = detectCaptchaOrOtp;

/**
 * Switches browser from headless to headful mode at the specified URL upon CAPTCHA detection.
 * 1. Closes current headless browser
 * 2. Launches new browser with { headless: false }
 * 3. Navigates to currentUrl
 * 4. Returns { browser, page, context, appliedHeadfulAt }
 */
export async function switchToHeadfulMode(
  browser: Browser,
  currentUrl: string,
  options: { headless?: boolean } = {}
): Promise<{ browser: Browser; context: BrowserContext; page: Page; appliedHeadfulAt: number }> {
  console.log(`[Live Submit] 🖥️ Switching to headful browser for URL ${currentUrl}...`);

  // Closes current headless browser
  await browser.close().catch(() => {});

  const appliedHeadfulAt = Date.now();
  const isHeadless = options.headless !== undefined ? options.headless : false;

  const newBrowser = await chromium.launch({
    headless: isHeadless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const context = await newBrowser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(currentUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  return { browser: newBrowser, context, page, appliedHeadfulAt };
}

/**
 * Compatibility wrapper for switchBrowserToHeadful using application row.
 */
export async function switchBrowserToHeadful(
  application: ApplicationRow,
  currentBrowser: Browser,
  targetUrl: string,
  options: { headless?: boolean } = {}
): Promise<{ browser: Browser; context: BrowserContext; page: Page; appliedHeadfulAt: number }> {
  console.log(
    `[Live Submit] 🖥️ Switching to headful browser for application ${application.id || application.applywizz_id}...`
  );
  return switchToHeadfulMode(currentBrowser, targetUrl, options);
}

export interface PollCaptchaOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  browser?: Browser;
}

/**
 * Polls every 500ms for up to 5 minutes (or options.timeoutMs) for CAPTCHA resolution.
 * - Checks:
 *   1. CAPTCHA iframe is gone: !await page.$('iframe[src*="turnstile"]') (and recaptcha/hcaptcha)
 *   2. Submit button is enabled/clickable: await page.$('button[type="submit"]:not([disabled])')
 * - On both conditions true: auto-clicks submit button, proceeds to verification & proof capture
 * - If timeout reached: captures failure screenshot, closes browser, returns status CAPTCHA_TIMEOUT
 */
export async function pollCaptchaSolved(
  applicationId: string,
  page: Page,
  application: ApplicationRow,
  options: PollCaptchaOptions = {}
): Promise<LiveSubmitResult> {
  const timeoutMs = options.timeoutMs ?? 300000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const startTime = Date.now();

  console.log(
    `[Live Submit] 🔄 Polling for CAPTCHA resolution for application ${applicationId} (every ${pollIntervalMs}ms, up to ${timeoutMs / 1000}s)...`
  );

  while (Date.now() - startTime < timeoutMs) {
    try {
      if (page.isClosed()) {
        break;
      }

      // Check if CAPTCHA iframe is gone
      const turnstile = await page.$('iframe[src*="turnstile"]').catch(() => null);
      const recaptcha = await page.$('iframe[src*="recaptcha"]').catch(() => null);
      const hcaptcha = await page.$('iframe[src*="hcaptcha"]').catch(() => null);
      const cf = await page.$('iframe[src*="challenges.cloudflare.com"]').catch(() => null);
      const captchaPresent = Boolean(turnstile || recaptcha || hcaptcha || cf);

      // Check if submit button is enabled/clickable
      const submitSelectors = [
        'button[type="submit"]:not([disabled])',
        'input[type="submit"]:not([disabled])',
        '#submit_app:not([disabled])',
        'button:has-text("Submit Application"):not([disabled])',
        'input[value*="Submit"]:not([disabled])',
        'button:has-text("Apply"):not([disabled])',
        '#submit_application:not([disabled])',
      ];

      let submitBtn: Locator | null = null;
      for (const sel of submitSelectors) {
        const loc = page.locator(sel).first();
        if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
          const isDis = await loc.isDisabled().catch(() => false);
          if (!isDis) {
            submitBtn = loc;
            break;
          }
        }
      }

      if (!captchaPresent && submitBtn) {
        console.log(`[Live Submit] ✅ CAPTCHA solved! Auto-clicking submit button...`);
        await submitBtn.click({ timeout: 5000 });

        await page.waitForTimeout(1500);

        // Check if OTP field appeared post-submit
        const otpField = await detectOTPField(page);
        if (otpField.found) {
          console.warn(
            `[Live Submit] 🔢 OTP requirement detected after CAPTCHA solve (${otpField.selector})`
          );
          if (application.id) {
            await updateStatus(application.id, 'OTP_REQUIRED');
          }
          const sessionKey = storePausedSession(application, {
            browser: options.browser || PAUSED_SESSIONS.get(applicationId)?.browser!,
            page,
            applicationId,
            jobUrl: application.job_url,
            ...buildOtpPauseMetadata(otpField),
          });
          return {
            success: false,
            status: 'OTP_REQUIRED',
            applicationId: sessionKey,
            message: 'OTP required. Enter code in dashboard.',
            requiresOtp: true,
            challengeType: 'otp',
          };
        }

        // Verification signals (30s timeout)
        const verification = await verifySubmissionSignals(page, 30000);
        if (verification.verified) {
          console.log(`[Live Submit] 🎉 Submission verified after CAPTCHA solve! Signal: ${verification.signal}`);
          const proofResult = await captureWebProof(page, application);
          if (proofResult.proofWebUrl) {
            console.log(`[Live Submit] 📸 Success web proof screenshot URL: ${proofResult.proofWebUrl}`);
          }
          if (application.id) {
            await updateStatus(application.id, 'APPLIED', {
              proof_web_url: proofResult.proofWebUrl,
              proof_captured_at: proofResult.proofCapturedAt,
            });
          }

          // Asynchronously capture confirmation email proof from Zoho Mail in the background
          captureAndSaveEmailProof(application).catch((err: any) => {
            console.warn(`[Live Submit] ⚠️ Background email proof capture failed: ${err.message}`);
          });

          const resolved = resolvePausedSession(applicationId);
          if (resolved) {
            resolved.session.screenshotCaptured = true;
          }
          await clearPausedSession(applicationId);
          await closeSubmissionSession(applicationId);

          return {
            success: true,
            status: 'APPLIED',
            applicationId,
            proofWebUrl: proofResult.proofWebUrl,
            proofCapturedAt: proofResult.proofCapturedAt,
          };
        } else {
          const isTimeout = /time.*out/i.test(verification.error || '');
          const errorMsg = verification.error || 'Timeout: Submission verification timed out.';
          if (isTimeout) {
            console.warn(`[Live Submit] ⏱️ Timeout: ${errorMsg} for application ${applicationId}`);
          } else {
            console.warn(`[Live Submit] ❌ Verification failed: ${errorMsg}`);
          }
          let failedProofUrl: string | undefined;
          let failedCapturedAt: string | undefined;
          try {
            const failed = await captureFailedScreenshot(page, application);
            if (failed?.url) {
              console.log(`[Live Submit] 📸 Timeout failure screenshot URL: ${failed.url}`);
              failedProofUrl = failed.proofFailedUrl || failed.url;
              failedCapturedAt = failed.proofFailedCapturedAt || failed.capturedAt;
            }
          } catch {}
          if (application.id) {
            await updateStatus(application.id, 'FAILED', {
              error_message: errorMsg,
              proof_failed_url: failedProofUrl,
              proof_failed_captured_at: failedCapturedAt,
              job_url: application.job_url,
            });
          }
          await clearPausedSession(applicationId);
          await closeSubmissionSession(applicationId);

          return {
            success: false,
            status: 'FAILED',
            applicationId,
            errorMessage: errorMsg,
            proofFailedUrl: failedProofUrl,
            proofFailedCapturedAt: failedCapturedAt,
          };
        }
      }
    } catch {
      // Continue polling
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  // Timeout reached (5 min)
  const timeoutMsg = 'Timeout: Session timed out after 5 minutes';
  console.warn(`[Live Submit] ⏱️ Timeout: ${timeoutMsg} for application ${applicationId}`);

  let timeoutFailedUrl: string | undefined;
  let timeoutCapturedAt: string | undefined;
  try {
    if (!page.isClosed()) {
      const failed = await captureFailedScreenshot(page, application);
      if (failed?.url) {
        console.log(`[Live Submit] 📸 Timeout failure screenshot URL: ${failed.url}`);
        timeoutFailedUrl = failed.proofFailedUrl || failed.url;
        timeoutCapturedAt = failed.proofFailedCapturedAt || failed.capturedAt;
      }
    }
  } catch (err: any) {
    console.warn(`[Live Submit] ⚠️ Pre-close failure screenshot failed: ${err.message}`);
  }

  const targetAppId = application.id || application.applywizz_id || applicationId;
  if (targetAppId) {
    try {
      await updateStatus(targetAppId, 'FAILED', {
        error_message: timeoutMsg,
        proof_failed_url: timeoutFailedUrl,
        proof_failed_captured_at: timeoutCapturedAt,
        job_url: application.job_url,
      });
    } catch (err: any) {
      console.warn(`[Live Submit] ⚠️ Error updating status to FAILED on timeout: ${err.message}`);
    }
  }

  await clearPausedSession(applicationId);
  await closeSubmissionSession(applicationId);

  return {
    success: false,
    status: 'CAPTCHA_TIMEOUT',
    applicationId,
    message: timeoutMsg,
    errorMessage: timeoutMsg,
    proofFailedUrl: timeoutFailedUrl,
    proofFailedCapturedAt: timeoutCapturedAt,
  };
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
  errorMessage?: string;
}

/**
 * Fills a paused OTP prompt, submits verification, and completes the application if confirmed.
 * Supports alphanumeric codes and multiple separate digit/character boxes.
 */
export async function submitOtpToPausedSession(
  applicationId: string,
  otp: string,
  options: { timeoutMs?: number; jobUrl?: string } = {}
): Promise<SubmitOtpResult> {
  const timeoutMs = options.timeoutMs ?? 30000;
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
        const failed = await captureFailedScreenshot(page, application).catch(() => null);
        if (failed?.url) {
          console.log(`[Live Submit] 📸 OTP missing field failure screenshot URL: ${failed.url}`);
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

  console.log(`[Live Submit] 🔢 Submitting OTP for ${canonicalKey} (alphanumeric, multiBox=${isMultiBox})`);

  if (application.id) {
    try {
      await updateStatus(application.id, 'APPLYING');
    } catch (err: any) {
      console.warn(`[Live Submit] ⚠️ Could not set status APPLYING: ${err.message}`);
    }
  }

  try {
    if (isMultiBox && boxSelectors.length > 0) {
      const chars = cleanOtp.split('');
      console.log(
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
        console.log(`[Live Submit] 🖱️ Clicking OTP verify button (${sel})...`);
        await btn.click({ timeout: 5000 });
        verifyClicked = true;
        break;
      }
    }

    if (!verifyClicked) {
      console.log('[Live Submit] ↩️ No OTP verify button found — pressing Enter on OTP field.');
      if (isMultiBox && boxSelectors.length > 0) {
        const lastBox = page.locator(boxSelectors[boxSelectors.length - 1]).first();
        await lastBox.press('Enter').catch(() => {});
      } else {
        const otpInput = page.locator(otpSelector).first();
        await otpInput.press('Enter').catch(() => {});
      }
    }

    console.log(`[Live Submit] ⏳ Waiting up to ${timeoutMs / 1000}s for confirmation after OTP...`);
    const verification = await verifySubmissionSignals(page, timeoutMs);

    if (verification.verified) {
      console.log(`[Live Submit] 🎉 OTP verification confirmed! Signal: ${verification.signal}`);

      const proofResult = await captureWebProof(page, application);
      session.screenshotCaptured = true;
      if (proofResult.proofWebUrl) {
        console.log(`[Live Submit] 📸 Success web proof screenshot URL: ${proofResult.proofWebUrl}`);
      }

      const targetAppId = application.id || canonicalKey;
      const submittedAt = new Date().toISOString();
      await updateStatus(targetAppId, 'EMAIL_PROOF_PENDING', {
        proof_web_url: proofResult.proofWebUrl,
        proof_captured_at: proofResult.proofCapturedAt,
        job_url: application.job_url,
      });

      await closeSubmissionSession(canonicalKey);
      await clearPausedSession(canonicalKey);

      // Attempt immediate confirmation email verification (up to 15s)
      console.log(`[Live Submit] 📧 Checking for immediate confirmation email after OTP...`);
      const emailProof = await captureAndSaveEmailProof(application, {
        timeoutMs: 15000,
        sinceTimestamp: new Date(submittedAt).getTime() - 2 * 60 * 1000,
      }).catch(() => null);

      if (emailProof) {
        console.log(`[Live Submit] 🎉 Confirmation email verified immediately after OTP! Marking APPLIED.`);
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
          applicationId: canonicalKey,
          proofUrl: proofResult.proofWebUrl,
          proofWebUrl: proofResult.proofWebUrl,
          proofCapturedAt: proofResult.proofCapturedAt,
        };
      }

      // Zero matches on immediate check: transition to EMAIL_PROOF_PENDING & start 30s background retry
      console.log(
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
      ? 'Timeout: OTP was not filled in time.'
      : (verification.error || 'OTP submission verification failed.');

    if (isTimeout) {
      console.warn(`[Live Submit] ⏱️ Timeout: OTP verification timed out for application ${canonicalKey}`);
    } else {
      console.warn(`[Live Submit] ❌ OTP submission verification failed: ${errorMsg}`);
    }

    let failedProofUrl: string | undefined;
    let failedCapturedAt: string | undefined;
    // Capture failure screenshot on verification failure
    if (page && !page.isClosed()) {
      const failed = await captureFailedScreenshot(page, application).catch(() => null);
      if (failed?.url) {
        console.log(`[Live Submit] 📸 OTP verification failure screenshot URL: ${failed.url}`);
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
      console.warn(`[Live Submit] ⏱️ Timeout: OTP submission timed out for ${canonicalKey}`);
    } else {
      console.error(`[Live Submit] ❌ OTP submit error for ${canonicalKey}:`, err);
    }

    let errProofUrl: string | undefined;
    let errCapturedAt: string | undefined;
    if (page && !page.isClosed()) {
      const failed = await captureFailedScreenshot(page, application).catch(() => null);
      if (failed?.url) {
        console.log(`[Live Submit] 📸 OTP submit error failure screenshot URL: ${failed.url}`);
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
      console.warn(`[Live Submit] ⚠️ Could not upsert application record before submit: ${err.message}`);
    }
  }

  const applicationId = application.id || application.applywizz_id || 'live-submit-app';
  const targetUrl = application.job_url;

  if (!targetUrl) {
    throw new Error(`Application ${applicationId} has no job_url specified.`);
  }

  console.log(
    `[Live Submit] 🚀 Initiating live submission for ${application.applywizz_id} [${targetUrl}] (headless: true)...`
  );

  // Update DB status to APPLYING
  if (application.id) {
    try {
      await updateStatus(application.id, 'APPLYING');
    } catch (err: any) {
      console.warn(`[Live Submit] ⚠️ Could not set status APPLYING: ${err.message}`);
    }
  }

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let fillSummary: FormFillSummary | undefined;
  let keepSessionOpen = false;
  let screenshotCaptured = false;

  try {
    // 2. Launch headless browser with anti-detection flags (strictly headless; never headful)
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    page = await context.newPage();

    // 3. Navigate to the job application URL
    console.log(`[Live Submit] 🌐 Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Capture screenshot after navigating to job URL, before filling form
    try {
      const openResult = await captureJobOpenScreenshot(page, application);
      if (openResult.url) {
        console.log(`[Live Submit] 📸 Job open screenshot URL: ${openResult.url}`);
      }
    } catch (openErr: any) {
      console.warn(`[Live Submit] ⚠️ Could not capture job open screenshot: ${openErr.message}`);
    }

    // 4. Fill all form fields
    try {
      fillSummary = await fillForm(page, application, {
        minJitterMs: options.minJitterMs ?? 300,
        maxJitterMs: options.maxJitterMs ?? 800,
        timeoutMs: 5000,
      });
    } catch (fillErr: any) {
      const fillErrMsg = `Form filling error: ${fillErr.message || 'Failed to populate application fields.'}`;
      console.error(`[Live Submit] ❌ ${fillErrMsg} for application ${applicationId}`);
      let failedProof: any = null;
      if (page && !page.isClosed()) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
        if (failedProof?.url) {
          console.log(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
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
        console.log(`[Live Submit] 🖱️ Clicking submit button (${sel})...`);
        await btn.click({ timeout: 5000 });
        submitClicked = true;
        break;
      }
    }

    if (!submitClicked) {
      const fillErrMsg = 'Form filling error: Submit button could not be located on the application form.';
      console.error(`[Live Submit] ❌ ${fillErrMsg} for application ${applicationId}`);
      let failedProof: any = null;
      if (page && !page.isClosed()) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
        if (failedProof?.url) {
          console.log(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
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
        console.log(`[Live Submit] 📸 Job submitted screenshot URL: ${submittedResult.url}`);
      }
    } catch (subErr: any) {
      console.warn(`[Live Submit] ⚠️ Could not capture job submitted screenshot: ${subErr.message}`);
    }

    // 6. Wait 2-3 seconds for page to respond after submit click
    console.log('[Live Submit] ⏳ Waiting 2-3s for page response post-submit...');
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
      console.log(
        `[Live Submit] 🚀 Submission responded successfully (urlChanged=${urlChanged}, url=${currentUrl}). Continuing to confirmation verification...`
      );
    } else {
      // Check for OTP field requirement
      const otpField = await detectOTPField(page);
      if (otpField.found) {
        console.warn(
          `[Live Submit] 🔢 OTP input detected post-submit (${otpField.selector})` +
            `${otpField.metadata?.type ? ` [type=${otpField.metadata.type}]` : ''}` +
            `${otpField.metadata?.matchReason ? ` — ${otpField.metadata.matchReason}` : ''}`
        );

        if (application.id) {
          await updateStatus(application.id, 'OTP_REQUIRED');
        }

        const pausedAt = Date.now();
        const sessionKey = storePausedSession(application, {
          browser,
          page,
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

        // --- Automated Zoho Mail Reader OTP Resolution ---
        let companyEmail: string | null = null;
        try {
          const profile = await getProfile(application.applywizz_id);
          if (profile) {
            companyEmail = getCompanyEmail(profile);
          }
        } catch (profErr: any) {
          console.warn(`[Live Submit] ⚠️ Could not fetch profile for company email: ${profErr.message}`);
        }

        if (companyEmail && config.ZOHO_CONNECTOR_USER && config.ZOHO_CONNECTOR_PASS) {
          console.log(
            `[Live Submit] 🤖 Automated OTP resolution enabled. Querying Zoho Mail Reader for ${companyEmail}...`
          );
          try {
            const otpDetectedTime = pausedAt || Date.now();
            const zohoResult = await zohoReader.fetchLatestOtp(companyEmail, {
              timeoutMs: Math.max(config.ZOHO_CONNECTOR_TIMEOUT_MS || 120000, 120000),
              sinceTimestamp: otpDetectedTime - 60000,
            });

            if (zohoResult.success && zohoResult.otp) {
              console.log(`[Live Submit] 🔑 Received OTP (${zohoResult.otp}) from Zoho Mail. Auto-submitting...`);
              const submitResult = await submitOtpToPausedSession(sessionKey, zohoResult.otp, {
                timeoutMs: options.timeoutMs ?? 30000,
                jobUrl: targetUrl,
              });

              if (submitResult.status === 'APPLIED') {
                keepSessionOpen = false; // session was completed & closed inside submitOtpToPausedSession
                return {
                  success: true,
                  status: 'APPLIED',
                  applicationId,
                  proofWebUrl: submitResult.proofWebUrl,
                  proofCapturedAt: submitResult.proofCapturedAt,
                  summary: fillSummary,
                };
              } else {
                throw new Error(submitResult.errorMessage || 'Auto-submitted OTP was rejected or failed verification.');
              }
            } else {
              throw new Error(zohoResult.errorMessage || 'Timeout: OTP was not filled in time.');
            }
          } catch (autoOtpErr: any) {
            const isTimeout = /time.*out|not filled in time/i.test(autoOtpErr.message || '');
            const otpErrMsg = isTimeout
              ? 'Timeout: OTP was not filled in time.'
              : `OTP error: ${autoOtpErr.message}`;

            if (isTimeout) {
              console.warn(`[Live Submit] ⏱️ Timeout: OTP was not filled in time for application ${applicationId}`);
            } else {
              console.error(`[Live Submit] ❌ ${otpErrMsg} for application ${applicationId}`);
            }
            // User requested error out on failure
            keepSessionOpen = false;
            screenshotCaptured = true;
            const failedProof = await captureFailedScreenshot(page, application).catch(() => null);
            if (application.id) {
              await updateStatus(application.id, 'FAILED', {
                error_message: otpErrMsg,
                proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
                proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
                job_url: application.job_url,
              }).catch(() => {});
            }
            await clearPausedSession(sessionKey).catch(() => {});
            await closeSubmissionSession(sessionKey).catch(() => {});

            return {
              success: false,
              status: 'FAILED',
              applicationId,
              errorMessage: otpErrMsg,
              summary: fillSummary,
              proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
              proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
            };
          }
        }

        // Fallback: manual OTP entry via dashboard if Zoho credentials not configured
        return {
          success: false,
          status: 'OTP_REQUIRED',
          applicationId,
          message: 'OTP required. Enter code in dashboard.',
          requiresOtp: true,
          requiresCaptcha: true,
          challengeType: 'otp',
          summary: fillSummary,
        };
      }

      // Check for form filling / validation errors on page before assuming CAPTCHA block
      const fillError = await detectFormFillingErrors(page);
      if (fillError.hasError) {
        const fillErrMsg = `Form filling error: ${fillError.message}`;
        console.error(`[Live Submit] ❌ ${fillErrMsg} for application ${applicationId}`);
        let failedProof: any = null;
        if (page && !page.isClosed()) {
          failedProof = await captureFailedScreenshot(page, application).catch(() => null);
          if (failedProof?.url) {
            console.log(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
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

      // Check if submission was actually blocked:
      // 1. Look for error message on page: pageText contains "challenge" / "verify" / "security" / "try again"
      const hasBlockErrorMessage =
        pageText.includes('challenge') ||
        pageText.includes('verify') ||
        pageText.includes('security') ||
        pageText.includes('try again');

      // 2. Check if submit button is visible and clickable again (reset state = blocked)
      let isSubmitButtonReset = false;
      for (const sel of submitSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
          const isDis = await btn.isDisabled().catch(() => true);
          if (!isDis) {
            isSubmitButtonReset = true;
            break;
          }
        }
      }

      // 3. Check for CAPTCHA iframe
      const postSubmitCaptcha = await detectCaptchaIframe(page);

      // Trigger ONLY on actual block:
      // URL not changed + (error message on page OR (CAPTCHA iframe detected + submit button reset to clickable))
      const isActuallyBlocked =
        !urlChanged &&
        (hasBlockErrorMessage || (postSubmitCaptcha.detected && isSubmitButtonReset));

      if (isActuallyBlocked) {
        console.warn(
          `[Live Submit] 🛑 Actual submission block detected post-submit (errorMsg=${hasBlockErrorMessage}, buttonReset=${isSubmitButtonReset}, captcha=${postSubmitCaptcha.detected ? postSubmitCaptcha.type : 'none'}). Switching to headful browser...`
        );
        keepSessionOpen = true;
        const headful = await switchToHeadfulMode(browser, targetUrl, {
          headless: options.headless,
        });
        browser = headful.browser;
        context = headful.context;
        page = headful.page;

        try {
          fillSummary = await fillForm(page, application, {
            minJitterMs: options.minJitterMs ?? 300,
            maxJitterMs: options.maxJitterMs ?? 800,
            timeoutMs: 5000,
          });
        } catch {}

        storePausedSession(application, {
          browser,
          page,
          applicationId,
          jobUrl: targetUrl,
          appliedHeadfulAt: headful.appliedHeadfulAt,
          pausedAt: headful.appliedHeadfulAt,
          requiresOtp: false,
          challengeType: 'captcha',
        });

        registerSubmissionSession({
          applicationId,
          browser,
          context,
          page,
          application,
          startedAt: headful.appliedHeadfulAt,
        });

        if (application.id) {
          await updateStatus(application.id, 'OTP_REQUIRED');
        }

        if (options.autoPollCaptcha !== false) {
          return await pollCaptchaSolved(applicationId, page, application, {
            timeoutMs: options.captchaTimeoutMs ?? 300000,
            browser,
          });
        }

        return {
          success: false,
          status: 'OTP_REQUIRED',
          applicationId,
          message: 'CAPTCHA detected. Solve in headful browser.',
          requiresOtp: false,
          requiresCaptcha: true,
          challengeType: 'captcha',
          summary: fillSummary,
        };
      } else {
        console.log(
          `[Live Submit] ℹ️ No actual block detected (urlChanged=${urlChanged}, buttonReset=${isSubmitButtonReset}, hasBlockError=${hasBlockErrorMessage}). Continuing to confirmation verification...`
        );
      }
    }

    // 7. Multi-Signal Completion Verification (up to 30s)
    console.log(`[Live Submit] ⏳ Waiting up to ${timeoutMs / 1000}s for submission confirmation signals...`);
    const verification = await verifySubmissionSignals(page, timeoutMs);

    if (verification.verified) {
      console.log(`[Live Submit] 🎉 Submission verified! Signal: ${verification.signal}`);

      // 8. Capture full-page proof screenshot & attach to application (like dry-run)
      const proofResult = await captureWebProof(page, application);
      screenshotCaptured = true;
      if (proofResult.proofWebUrl) {
        console.log(`[Live Submit] 📸 Success web proof screenshot URL: ${proofResult.proofWebUrl}`);
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
      console.log(`[Live Submit] 📧 Checking for immediate confirmation email matching company & apply time...`);
      const emailProof = await captureAndSaveEmailProof(application, {
        timeoutMs: 15000,
        sinceTimestamp: new Date(submittedAt).getTime() - 2 * 60 * 1000,
      }).catch(() => null);

      if (emailProof) {
        console.log(`[Live Submit] 🎉 Confirmation email verified immediately! Marking APPLIED.`);
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
          summary: fillSummary,
        };
      }

      // Zero matches on immediate check: transition to EMAIL_PROOF_PENDING & start 30s background retry
      console.log(
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
      const isTimeout = /time.*out/i.test(verification.error || '');
      const isFormError = /form (filling|validation) error/i.test(verification.error || '');
      let errorMsg: string;

      if (isFormError) {
        errorMsg = verification.error || 'Form filling error: Validation failed.';
        console.error(`[Live Submit] ❌ ${errorMsg} for application ${applicationId}`);
      } else if (isTimeout) {
        errorMsg = 'Timeout: Submission verification timed out after 30s.';
        console.warn(`[Live Submit] ⏱️ Timeout: ${errorMsg} for application ${applicationId}`);
      } else {
        errorMsg = verification.error || 'Submission verification failed.';
        console.warn(`[Live Submit] ❌ Submission verification failed: ${errorMsg} for application ${applicationId}`);
      }

      let failedProof: any = null;
      if (page && !page.isClosed() && !screenshotCaptured) {
        failedProof = await captureFailedScreenshot(page, application).catch(() => null);
        if (failedProof?.url) {
          console.log(`[Live Submit] 📸 Submission verification failure screenshot URL: ${failedProof.url}`);
        }
        screenshotCaptured = true;
      }

      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: errorMsg,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        });
      }

      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: errorMsg,
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
      console.error(`[Live Submit] ❌ ${finalErrMsg} for application ${applicationId}`);
    } else if (isTimeout) {
      finalErrMsg = `Timeout: ${err.message}`;
      console.warn(`[Live Submit] ⏱️ Timeout: ${finalErrMsg} for application ${applicationId}`);
    } else {
      console.error(`[Live Submit] ❌ Submission execution error for application ${applicationId}: ${finalErrMsg}`);
    }

    let failedProof: any = null;
    if (page && !page.isClosed() && !screenshotCaptured) {
      failedProof = await captureFailedScreenshot(page, application).catch(() => null);
      if (failedProof?.url) {
        console.log(`[Live Submit] 📸 Failure screenshot URL: ${failedProof.url}`);
      }
      screenshotCaptured = true;
    }

    if (application.id) {
      try {
        await updateStatus(application.id, 'FAILED', {
          error_message: finalErrMsg,
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
          console.log(`[Live Submit] 📸 Capturing failure screenshot before closing browser for ${applicationId}...`);
          const failed = await captureFailedScreenshot(page, application);
          if (failed?.url) {
            console.log(`[Live Submit] 📸 Pre-close failure screenshot URL: ${failed.url}`);
            const targetAppId = application.id || application.applywizz_id;
            if (targetAppId) {
              await updateStatus(targetAppId, 'FAILED', {
                proof_failed_url: failed.proofFailedUrl || failed.url,
                proof_failed_captured_at: failed.proofFailedCapturedAt || failed.capturedAt,
                job_url: application.job_url,
              }).catch(() => {});
            }
          }
        } catch (preCloseErr: any) {
          console.warn(`[Live Submit] ⚠️ Pre-close screenshot failed: ${preCloseErr.message}`);
        }
      }
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      console.log(`[Live Submit] 🏁 Closed browser context for application ${applicationId}.`);
    } else {
      console.log(
        `[Live Submit] ⏸️ Browser context kept paused in memory for application ${applicationId}.`
      );
    }
  }
}

export default runLiveSubmit;
