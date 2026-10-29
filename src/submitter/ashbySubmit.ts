/**
 * @fileoverview End-to-End Submission Engine for Ashby ATS Applications.
 */

import fs from 'fs';
import type {
  ApplicationRow,
  AshbySubmissionStage,
  AshbySubmissionTelemetry,
} from '../db/applications/types.js';
import { updateStatus } from '../db/applications/crud.js';
import { getProfile } from '../db/profiles.js';
import { getDbClient, isSupabaseConfigured } from '../db/client.js';
import { buildAshbyProxyConfig, resolveCountryCode, verifyProxyPreflight } from './ashbyProxy.js';
import { fillAshbyForm, sleep, verifyRequiredFieldsCommitted } from './ashbyFormFiller.js';
import { browserManager } from './browserManager.js';
import { downloadResumeTempFile, uploadProof, uploadFailedScreenshot } from '../db/storage.js';
import { createLogger, haltWithDevAlert } from '../utils/logger.js';
import type { LiveSubmitResult } from './liveSubmit.js';

const log = createLogger('AshbySubmit');

export function capTelemetryMetadata(
  telemetry: AshbySubmissionTelemetry,
  maxBytes = 1024
): Record<string, unknown> {
  let metadata: Record<string, unknown> = { ...telemetry };
  let metaStr = JSON.stringify(metadata);
  if (Buffer.byteLength(metaStr, 'utf8') <= maxBytes) {
    return metadata;
  }
  if (metadata.errorMessage && typeof metadata.errorMessage === 'string') {
    metadata.errorMessage = (metadata.errorMessage as string).slice(0, 200);
    metaStr = JSON.stringify(metadata);
    if (Buffer.byteLength(metaStr, 'utf8') <= maxBytes) {
      return metadata;
    }
  }
  metadata = {
    stage: telemetry.stage,
    deployedCommit: telemetry.deployedCommit,
    exitIpHash: telemetry.exitIpHash,
    proxyRegion: telemetry.proxyRegion,
    committedFieldCount: telemetry.committedFieldCount,
    challengeType: telemetry.challengeType,
    submitResponseStatus: telemetry.submitResponseStatus,
    capturedAt: telemetry.capturedAt,
  };
  metaStr = JSON.stringify(metadata);
  if (Buffer.byteLength(metaStr, 'utf8') <= maxBytes) {
    return metadata;
  }
  return { stage: telemetry.stage, capturedAt: telemetry.capturedAt };
}

export async function submitAshbyApplication(
  application: ApplicationRow,
  options: {
    headless?: boolean;
    updateStatusFn?: (id: string, status: any, extra?: any) => Promise<any>;
  } = {}
): Promise<LiveSubmitResult & { telemetry?: AshbySubmissionTelemetry }> {
  const applicationId = application.id || application.applywizz_id;
  const isHeadless = options.headless ?? (process.env.RAILWAY_ENV === 'true' || process.env.HEADLESS !== 'false');
  const deployedCommit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'local';
  const statusUpdater = options.updateStatusFn || updateStatus;

  log.info(`[AshbySubmit] 🚀 Starting Ashby submission for ${application.applywizz_id} [${application.job_url}]`);

  let stage: AshbySubmissionStage = 'PREFLIGHT';
  let exitIpHash: string | undefined;
  let proxyRegion: string | undefined;
  let committedFieldCount: number | undefined;
  let challengeType: 'none' | 'hcaptcha' | 'turnstile' | 'recaptcha' | 'unknown' = 'none';
  let submitResponseStatus: number | undefined;

  let managedBrowser: any = null;
  let page: any = null;
  let resumeLocalPath = '';

  try {
    // 1. Check & Build mandatory DataImpulse proxy
    const profile = await getProfile(application.applywizz_id);
    if (!profile) {
      throw new Error(`Profile not found for candidate ${application.applywizz_id}`);
    }

    let proxyConfig;
    let countryCode: string | undefined;
    try {
      countryCode = resolveCountryCode(profile);
      proxyRegion = countryCode;
      proxyConfig = buildAshbyProxyConfig(profile);
    } catch (proxyErr: any) {
      haltWithDevAlert('AshbySubmit', `Cannot submit Ashby without proxy: ${proxyErr.message}`);
      throw proxyErr;
    }

    // 2. Prepare resume temp file
    try {
      resumeLocalPath = await downloadResumeTempFile(application.applywizz_id);
    } catch (resumeErr: any) {
      log.warn(`[AshbySubmit] Failed to download resume temp file: ${resumeErr.message}`);
    }

    if (application.id) {
      await statusUpdater(application.id, 'APPLYING');
    }

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

    // Listen for GraphQL submitApplication responses to capture status code
    page.on('response', (response: any) => {
      try {
        const url = response.url().toLowerCase();
        if (url.includes('submitapplication') || url.includes('submit-application')) {
          submitResponseStatus = response.status();
        } else if (url.includes('graphql')) {
          const postData = response.request().postData() || '';
          if (postData.includes('SubmitApplication') || postData.includes('submitApplication')) {
            submitResponseStatus = response.status();
          }
        }
      } catch {
        // ignore
      }
    });

    // 2.5 Verify proxy preflight probe
    stage = 'PREFLIGHT';
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

    stage = 'NAVIGATION';
    log.info(`[AshbySubmit] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

    stage = 'DOM_SCAN';
    await page.waitForSelector('[data-field-path]', { timeout: 15000 }).catch(() => {});
    await sleep(1500, 2500);

    // 3. Fill form fields
    stage = 'FORM_FILL';
    const fillResult = await fillAshbyForm(page, application.resolved_fields || [], resumeLocalPath);
    committedFieldCount = fillResult.filledCount;
    log.info(`[AshbySubmit] Form populated: ${fillResult.filledCount} fields filled.`);

    // 4. Scroll smoothly to bottom to allow Turnstile / Cloudflare challenges to settle
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    await sleep(2000, 3000);

    // 4.5 Pre-submit validation gate: verify all required fields are committed on the live DOM
    stage = 'PRE_SUBMIT';
    const requiredFieldPaths = (application.resolved_fields || [])
      .filter((f) => f.isRequired)
      .map((f) => f.fieldId || f.name)
      .filter((p): p is string => Boolean(p));

    const domVerification = await verifyRequiredFieldsCommitted(page, requiredFieldPaths);
    if (!domVerification.allCommitted) {
      log.warn(
        `[AshbySubmit] ⛔ Pre-submit validation failed for ${applicationId}. Missing required DOM fields: ${domVerification.missingFields.join(', ')}`
      );
      const preSubmitErr: any = new Error(
        `Pre-submit validation failed: Required field(s) uncommitted on DOM: ${domVerification.missingFields.join(', ')}`
      );
      preSubmitErr.stage = 'PRE_SUBMIT';
      preSubmitErr.classification = 'DATA_FAULT:MISSING_REQUIRED_FIELD';
      throw preSubmitErr;
    }

    // 5. Submit application
    stage = 'SUBMIT_CLICK';
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
    stage = 'WAIT_CONFIRMATION';
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

    stage = 'COMPLETED';
    log.info('[AshbySubmit] 🎉 Success signal confirmed!');
    await sleep(1000, 2000);

    // 7. Capture web proof screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const proofUrl = await uploadProof(applicationId, screenshotBuffer);

    // 8. Update status to APPLIED; updateStatus records submitted_at.
    if (application.id) {
      await statusUpdater(application.id, 'APPLIED', {
        proof_web_url: proofUrl,
        proof_captured_at: new Date().toISOString(),
        error_details: exitIpHash ? { exitIpHash, countryCode, stage: 'COMPLETED' } : undefined,
      });
    }

    return {
      success: true,
      status: 'APPLIED',
      applicationId,
      proofWebUrl: proofUrl,
      proofCapturedAt: new Date().toISOString(),
      telemetry: {
        deployedCommit,
        stage: 'COMPLETED',
        exitIpHash,
        proxyRegion,
        committedFieldCount,
        challengeType,
        submitResponseStatus,
        capturedAt: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    if (err.stage) {
      stage = err.stage;
    }
    const classification = err.classification;
    log.error(`[AshbySubmit] ❌ Submission failed for ${applicationId} at stage ${stage}: ${errorMsg}`);

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

    const telemetry: AshbySubmissionTelemetry = {
      deployedCommit,
      stage,
      exitIpHash,
      proxyRegion,
      committedFieldCount,
      challengeType,
      submitResponseStatus,
      errorMessage: errorMsg,
      capturedAt: new Date().toISOString(),
    };

    if (application.id) {
      await statusUpdater(application.id, 'FAILED', {
        error_message: errorMsg,
        error_details: telemetry,
        proof_failed_url: failedProofUrl,
        proof_failed_captured_at: failedProofUrl ? new Date().toISOString() : undefined,
      }).catch(() => {});
    }

    if (isSupabaseConfigured()) {
      try {
        const metadata = capTelemetryMetadata(telemetry, 1024);
        const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const validAppId = application.id && idPattern.test(application.id) ? application.id : null;

        await getDbClient().from('gh_failure_diagnostics').insert({
          phase: 'SUBMIT',
          stage,
          category: classification || (stage === 'FORM_FILL' ? 'SUBMIT_FORM_FILL_ERROR' : stage === 'WAIT_CONFIRMATION' ? 'SUBMIT_CONFIRMATION_TIMEOUT' : 'SUBMIT_PLAYWRIGHT_NAVIGATE'),
          reason: errorMsg.slice(0, 500),
          error_name: err?.name ? String(err.name).slice(0, 80) : null,
          error_code: submitResponseStatus ? String(submitResponseStatus) : null,
          is_terminal: false,
          is_retryable: stage !== 'SUBMIT_CLICK' && stage !== 'WAIT_CONFIRMATION',
          applywizz_id: application.applywizz_id || null,
          application_id: validAppId,
          job_url_ref: application.job_url ? application.job_url.slice(0, 300) : null,
          metadata,
        });
      } catch (diagErr: any) {
        log.warn(`[AshbySubmit] Failed to record failure diagnostics: ${diagErr.message}`);
      }
    }

    return {
      success: false,
      status: 'FAILED',
      applicationId,
      errorMessage: errorMsg,
      proofFailedUrl: failedProofUrl || undefined,
      telemetry,
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
