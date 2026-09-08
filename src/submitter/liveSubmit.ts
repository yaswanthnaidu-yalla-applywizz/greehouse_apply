/**
 * @fileoverview Playwright Live Submission Engine with CAPTCHA Detection & Multi-Signal Verification (Phase V2-4).
 *
 * Executes automated Greenhouse form submission:
 * 1. Launches isolated Playwright browser context
 * 2. Populates form via formFiller.ts
 * 3. Inspects for CAPTCHA iframes (Cloudflare Turnstile, reCAPTCHA, hCaptcha)
 *    - If detected: transitions status to CAPTCHA_REQUIRED and registers paused session
 * 4. Clicks the submit button
 * 5. Runs 30-second multi-signal completion verification (Title / DOM tokens / URL)
 * 6. On confirmation: captures full-page web proof, uploads to Supabase Storage, sets status APPLIED
 * 7. On timeout / failure: captures error details, sets status FAILED
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fillForm, type FormFillSummary, type FormFillerOptions } from './formFiller.js';
import { captureWebProof } from './proofCapture.js';
import {
  registerSubmissionSession,
  verifySubmissionSignals,
} from './captchaResume.js';
import {
  getApplication,
  updateStatus,
  type ApplicationRow,
  type ApplicationStatus,
} from '../db/applications.js';

export interface LiveSubmitOptions extends FormFillerOptions {
  /** Launch in headless mode (default: true) */
  headless?: boolean;
  /** Navigation and submission timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

export interface LiveSubmitResult {
  success: boolean;
  status: ApplicationStatus;
  applicationId: string;
  proofWebUrl?: string;
  requiresCaptcha?: boolean;
  errorMessage?: string;
  summary?: FormFillSummary;
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

/**
 * Checks if the page contains an active CAPTCHA challenge widget or iframe.
 */
export async function detectCaptcha(page: Page): Promise<{ detected: boolean; type?: string }> {
  for (const selector of CAPTCHA_SELECTORS) {
    try {
      const loc = page.locator(selector).first();
      const count = await loc.count();
      if (count > 0 && (await loc.isVisible().catch(() => true))) {
        return { detected: true, type: selector };
      }
    } catch {
      // Continue inspecting other selectors
    }
  }

  // Also check frames directly
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
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 30000;

  // 1. Resolve application record
  let application: ApplicationRow;
  if (typeof applicationOrId === 'string') {
    const fetched = await getApplication(applicationOrId);
    if (!fetched) {
      throw new Error(`Application record with ID '${applicationOrId}' not found.`);
    }
    application = fetched;
  } else {
    application = applicationOrId;
  }

  const applicationId = application.id || application.applywizz_id || 'live-submit-app';
  const targetUrl = application.job_url;

  if (!targetUrl) {
    throw new Error(`Application ${applicationId} has no job_url specified.`);
  }

  console.log(
    `[Live Submit] 🚀 Initiating live submission for ${application.applywizz_id} [${targetUrl}] (headless: ${headless})...`
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

  try {
    // 2. Launch browser with anti-detection flags
    browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
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

    // 4. Fill all form fields
    fillSummary = await fillForm(page, application, {
      minJitterMs: options.minJitterMs ?? 300,
      maxJitterMs: options.maxJitterMs ?? 800,
      timeoutMs: 5000,
    });

    // Settle DOM briefly
    await page.waitForTimeout(500);

    // 5. Inspect for CAPTCHA widgets
    const captchaCheck = await detectCaptcha(page);
    if (captchaCheck.detected) {
      console.warn(
        `[Live Submit] ⏸️ CAPTCHA detected (${captchaCheck.type}) on application ${applicationId}. Pausing submission for manual resolution.`
      );

      if (application.id) {
        await updateStatus(application.id, 'CAPTCHA_REQUIRED');
      }

      // Register session for later resume
      registerSubmissionSession({
        applicationId,
        browser,
        context,
        page,
        application,
        startedAt: Date.now(),
      });

      keepSessionOpen = true;

      return {
        success: false,
        status: 'CAPTCHA_REQUIRED',
        applicationId,
        requiresCaptcha: true,
        summary: fillSummary,
      };
    }

    // 6. Locate and click form submit button
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
      throw new Error('Submit button could not be located on the application form.');
    }

    // 7. Multi-Signal Completion Verification (up to 30s)
    console.log(`[Live Submit] ⏳ Waiting up to ${timeoutMs / 1000}s for submission confirmation signals...`);
    const verification = await verifySubmissionSignals(page, timeoutMs);

    if (verification.verified) {
      console.log(`[Live Submit] 🎉 Submission verified! Signal: ${verification.signal}`);

      // 8. Capture full-page proof screenshot & upload to Supabase Storage
      const proofResult = await captureWebProof(page, applicationId);

      // 9. Update DB status to APPLIED
      if (application.id) {
        await updateStatus(application.id, 'APPLIED');
      }

      return {
        success: true,
        status: 'APPLIED',
        applicationId,
        proofWebUrl: proofResult.proofWebUrl,
        summary: fillSummary,
      };
    } else {
      const errorMsg = verification.error || 'Submission verification timed out after 30s without confirmation signals.';
      console.warn(`[Live Submit] ❌ Submission verification failed: ${errorMsg}`);

      if (application.id) {
        await updateStatus(application.id, 'FAILED', errorMsg);
      }

      return {
        success: false,
        status: 'FAILED',
        applicationId,
        errorMessage: errorMsg,
        summary: fillSummary,
      };
    }
  } catch (err: any) {
    console.error(`[Live Submit] ❌ Submission execution error for ${applicationId}:`, err);

    if (application.id) {
      try {
        await updateStatus(application.id, 'FAILED', err.message);
      } catch {}
    }

    return {
      success: false,
      status: 'FAILED',
      applicationId,
      errorMessage: err.message,
      summary: fillSummary,
    };
  } finally {
    if (!keepSessionOpen) {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      console.log(`[Live Submit] 🏁 Closed browser context for application ${applicationId}.`);
    }
  }
}

export default runLiveSubmit;
