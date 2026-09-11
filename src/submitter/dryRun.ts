/**
 * @fileoverview Playwright Headful Dry-Run Engine (Phase V2-4).
 *
 * Launches a headful Chromium instance, populates all resolved candidate answers
 * using the Form Filler, stops before clicking submit, captures a full-page
 * screenshot of the filled form state, uploads it to Supabase Storage (`proofs_dry_run`),
 * and updates the application database record.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fillForm, type FormFillSummary } from './formFiller.js';
import { uploadDryRunScreenshot } from '../db/storage.js';
import {
  getApplication,
  setDryRunScreenshotUrl,
  updateStatus,
  type ApplicationRow,
} from '../db/applications.js';

export interface DryRunOptions {
  /** Launch browser in headless mode (default: false for visual inspection) */
  headless?: boolean;
  /** Navigation timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Minimum jitter delay in milliseconds (default: 200) */
  minJitterMs?: number;
  /** Maximum jitter delay in milliseconds (default: 500) */
  maxJitterMs?: number;
  /** Target job posting URL */
  jobUrl?: string;
}

export interface DryRunResult {
  success: boolean;
  applicationId: string;
  screenshotUrl: string;
  summary: FormFillSummary;
  error?: string;
}

/**
 * Runs a headful dry-run form filling session without submitting.
 *
 * @param applicationOrId - Application database record or UUID string
 * @param options - Configuration overrides for browser launch and timeouts
 * @returns Result object with dry-run screenshot URL and form fill summary
 */
export async function runDryRun(
  applicationOrId: string | ApplicationRow,
  options: DryRunOptions = {}
): Promise<DryRunResult> {
  const isContainer = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.PORT ||
    process.env.NODE_ENV === 'production' ||
    (!process.env.DISPLAY && process.platform !== 'win32' && process.platform !== 'darwin')
  );
  const headless = isContainer ? true : (options.headless ?? false);
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

  const applicationId = application.id || application.applywizz_id || 'dry-run-app';
  const targetUrl = application.job_url;

  if (!targetUrl) {
    throw new Error(`Application ${applicationId} has no job_url specified.`);
  }

  console.log(
    `[Dry Run] 🚀 Starting dry-run for ${application.applywizz_id} [${targetUrl}] (headless: ${headless}, isContainer: ${isContainer})...`
  );

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // 2. Launch Chromium browser
    browser = await chromium.launch({
      headless,
      slowMo: headless ? 0 : 80, // slow down interactions in headful so they're visible
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
    console.log(`[Dry Run] 🌐 Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // 4. Fill form fields without submitting
    const fillSummary = await fillForm(page, application, {
      minJitterMs: options.minJitterMs ?? 200,
      maxJitterMs: options.maxJitterMs ?? 500,
      timeoutMs: 5000,
    });

    // Settle DOM briefly before taking screenshot
    await page.waitForTimeout(1000);

    // 5. Capture full-page screenshot of filled form
    console.log(`[Dry Run] 📸 Capturing dry-run form screenshot...`);
    const screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: 'png',
    });

    // In headful mode: pause so the operator can see the filled form before the window closes
    if (!headless) {
      console.log(`[Dry Run] 👁 Headful mode — pausing 3s for visual inspection...`);
      await page.waitForTimeout(3000);
    }

    // 6. Upload screenshot to Supabase Storage (proofs_dry_run bucket)
    let screenshotUrl = '';
    try {
      screenshotUrl = await uploadDryRunScreenshot(applicationId, screenshotBuffer);
      console.log(`[Dry Run] ☁️ Uploaded dry-run screenshot to storage: ${screenshotUrl}`);
    } catch (uploadErr: any) {
      console.warn(`[Dry Run] ⚠️ Storage upload warning: ${uploadErr.message}`);
    }

    // 7. Update application state in Supabase
    const targetAppId = application.id || application.applywizz_id;
    if (targetAppId) {
      try {
        if (screenshotUrl) {
          await setDryRunScreenshotUrl(application, screenshotUrl);
        }
        await updateStatus(targetAppId, 'DRY_RUN_COMPLETE', { job_url: application.job_url });
      } catch (dbErr: any) {
        console.warn(`[Dry Run] ⚠️ Could not update DB status: ${dbErr.message}`);
      }
    }

    return {
      success: true,
      applicationId,
      screenshotUrl,
      summary: fillSummary,
    };
  } catch (err: any) {
    console.error(`[Dry Run] ❌ Dry-run failed for application ${applicationId}:`, err);
    return {
      success: false,
      applicationId,
      screenshotUrl: '',
      summary: {
        applicationId,
        jobUrl: targetUrl,
        totalFields: 0,
        filledFields: 0,
        failedFields: 0,
        results: [],
      },
      error: err.message,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    console.log(`[Dry Run] 🏁 Completed dry-run session for ${applicationId}.`);
  }
}

export default runDryRun;
