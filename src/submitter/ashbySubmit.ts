/**
 * @fileoverview End-to-End Submission Engine for Ashby ATS Applications.
 */

import fs from 'fs';
import type { ApplicationRow } from '../db/applications/types.js';
import { updateStatus } from '../db/applications/crud.js';
import { getProfile } from '../db/profiles.js';
import { buildAshbyProxyConfig, resolveCountryCode, verifyProxyPreflight } from './ashbyProxy.js';
import { fillAshbyForm, sleep } from './ashbyFormFiller.js';
import { browserManager } from './browserManager.js';
import { downloadResumeTempFile, uploadProof, uploadFailedScreenshot } from '../db/storage.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import type { LiveSubmitResult } from './liveSubmit.js';

const log = createLogger('AshbySubmit');

export async function submitAshbyApplication(
  application: ApplicationRow,
  options: { headless?: boolean } = {}
): Promise<LiveSubmitResult> {
  const applicationId = application.id || application.applywizz_id;
  const isHeadless = options.headless ?? (process.env.RAILWAY_ENV === 'true' || process.env.HEADLESS !== 'false');

  log.info(`[AshbySubmit] 🚀 Starting Ashby submission for ${application.applywizz_id} [${application.job_url}]`);

  // 1. Check & Build mandatory DataImpulse proxy
  const profile = await getProfile(application.applywizz_id);
  if (!profile) {
    throw new Error(`Profile not found for candidate ${application.applywizz_id}`);
  }

  let proxyConfig;
  let countryCode: string | undefined;
  try {
    countryCode = resolveCountryCode(profile);
    proxyConfig = buildAshbyProxyConfig(profile);
  } catch (proxyErr: any) {
    haltWithDevAlert('AshbySubmit', `Cannot submit Ashby without proxy: ${proxyErr.message}`);
    throw proxyErr;
  }

  // 2. Prepare resume temp file
  let resumeLocalPath = '';
  try {
    resumeLocalPath = await downloadResumeTempFile(application.applywizz_id);
  } catch (resumeErr: any) {
    log.warn(`[AshbySubmit] Failed to download resume temp file: ${resumeErr.message}`);
  }

  if (application.id) {
    await updateStatus(application.id, 'APPLYING');
  }

  let managedBrowser = null;
  let page = null;
  let exitIpHash: string | undefined;

  try {
    managedBrowser = await browserManager.acquireBrowser({
      headless: isHeadless,
      proxy: {
        server: proxyConfig.server,
        username: proxyConfig.username,
        password: proxyConfig.password,
      },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        ...(isHeadless ? [] : ['--start-maximized', '--window-position=50,50']),
      ],
    });

    const context = await managedBrowser.browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      timezoneId: 'America/New_York',
      locale: 'en-US',
    });

    page = await context.newPage();

    // 2.5 Verify proxy preflight probe
    log.info(`[AshbySubmit] Probing proxy preflight for ${applicationId} (${countryCode})...`);
    const preflight = await verifyProxyPreflight(page, countryCode);
    if (!preflight.success) {
      log.warn(`[AshbySubmit] ⚠️ Proxy preflight failed for ${applicationId}: ${preflight.error}`);
      throw new Error(`Ashby proxy preflight failed: ${preflight.error}`);
    }
    exitIpHash = preflight.exitIpHash;
    log.info(`[AshbySubmit] 🔒 Proxy preflight verified (exitIpHash: ${exitIpHash}, country: ${countryCode})`);

    const targetUrl = application.job_url.includes('/application')
      ? application.job_url
      : `${application.job_url.replace(/\/+$/, '')}/application`;

    log.info(`[AshbySubmit] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('[data-field-path]', { timeout: 15000 }).catch(() => {});
    await sleep(1500, 2500);

    // 3. Fill form fields
    const fillResult = await fillAshbyForm(page, application.resolved_fields || [], resumeLocalPath);
    log.info(`[AshbySubmit] Form populated: ${fillResult.filledCount} fields filled.`);

    // 4. Scroll smoothly to bottom to allow Turnstile / Cloudflare challenges to settle
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(2000, 3000);

    // 5. Submit application
    const submitBtn = page
      .locator('.ashby-application-form-submit-button, button:has-text("Submit Application"), button[type="submit"]')
      .first();

    if ((await submitBtn.count()) === 0) {
      throw new Error('Submit button not found on Ashby form');
    }

    log.info('[AshbySubmit] Clicking submit button...');
    await submitBtn.click();

    // 6. Wait for success signal
    // Reference: ashby_application_success.png
    // "Success: Your application was successfully submitted. We'll contact you if there are next steps."
    let confirmed = false;
    const startTime = Date.now();
    const timeoutMs = 45000;

    while (Date.now() - startTime < timeoutMs) {
      const pageText = (await page.textContent('body')) || '';
      const url = page.url();
      const title = await page.title();

      if (
        pageText.includes('Your application was successfully submitted') ||
        pageText.includes('application was successfully submitted') ||
        /thank you for applying|application received/i.test(pageText) ||
        url.includes('/confirmation') ||
        /success|thank/i.test(title)
      ) {
        confirmed = true;
        break;
      }
      await page.waitForTimeout(1500);
    }

    if (!confirmed) {
      throw new Error('Ashby application submit confirmation signal timed out after 45s');
    }

    log.info('[AshbySubmit] 🎉 Success signal confirmed!');
    await sleep(1000, 2000);

    // 7. Capture web proof screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const proofUrl = await uploadProof(applicationId, screenshotBuffer);

    // 8. Update status to APPLIED; updateStatus records submitted_at.
    if (application.id) {
      await updateStatus(application.id, 'APPLIED', {
        proof_web_url: proofUrl,
        proof_captured_at: new Date().toISOString(),
        error_details: exitIpHash ? { exitIpHash, countryCode } : undefined,
      });
    }

    return {
      success: true,
      status: 'APPLIED',
      applicationId,
      proofWebUrl: proofUrl,
      proofCapturedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    log.error(`[AshbySubmit] ❌ Submission failed for ${applicationId}: ${errorMsg}`);

    let failedProofUrl: string | null = null;
    if (page && !page.isClosed()) {
      try {
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        failedProofUrl = await uploadFailedScreenshot(applicationId, screenshotBuffer);
        log.info(`[AshbySubmit] 📸 Failure screenshot captured and uploaded: ${failedProofUrl}`);
      } catch (screenshotErr: any) {
        log.warn(`[AshbySubmit] Failed to capture failure screenshot: ${screenshotErr.message}`);
      }
    }

    if (application.id) {
      await updateStatus(application.id, 'FAILED', {
        error_message: errorMsg,
        error_details: {
          exitIpHash,
          countryCode,
          failureReason: errorMsg,
        },
        proof_failed_url: failedProofUrl,
        proof_failed_captured_at: failedProofUrl ? new Date().toISOString() : undefined,
      }).catch(() => {});
    }

    return {
      success: false,
      status: 'FAILED',
      applicationId,
      errorMessage: errorMsg,
      proofFailedUrl: failedProofUrl || undefined,
    };
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => {});
    }
    if (managedBrowser) {
      await browserManager.releaseBrowser(managedBrowser.browserId).catch(() => {});
    }
    if (resumeLocalPath && fs.existsSync(resumeLocalPath)) {
      try {
        fs.unlinkSync(resumeLocalPath);
      } catch {}
    }
  }
}
