/**
 * @fileoverview Express Router for Application Submissions, Dry-Runs, and Proofs (Phase V2-4).
 *
 * Endpoints:
 * - POST /api/applications/:id/dry-run: Triggers headful dry-run form filling and captures screenshot
 * - POST /api/applications/:id/submit: Triggers live automated submission with CAPTCHA check
 * - POST /api/applications/:id/open-captcha-session: Opens a headful browser for manual CAPTCHA solving
 * - POST /api/applications/:id/submit-otp: Fills OTP on paused session and completes submission
 * - POST /api/applications/:id/resume-submission: Resumes paused submission after manual CAPTCHA solving
 * - GET  /api/applications/:id/proof: Retrieves web proof screenshot URL and timestamp
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { config } from '../../config/env.js';
import { chromium } from 'playwright';
import { runDryRun } from '../../submitter/dryRun.js';
import {
  runLiveSubmit,
  resolvePausedSession,
  storePausedSession,
  clearPausedSession,
  submitOtpToPausedSession,
} from '../../submitter/liveSubmit.js';
import { verifySubmissionSignals, registerSubmissionSession } from '../../submitter/captchaResume.js';
import { captureWebProof, captureFailedScreenshot, captureAndSaveEmailProof } from '../../submitter/proofCapture.js';
import { emailProofPoller } from '../../submitter/emailProofPoller.js';
import { fillForm } from '../../submitter/formFiller.js';
import {
  getApplication,
  getApplicationByCandidateAndJob,
  updateStatus,
  enqueueApplication,
  hydrateApplicationProofUrls,
  requeueApplicationForRetry,
} from '../../db/applications.js';
import { getRetryReason } from '../../submitter/submissionRetry.js';
import { isUserAdmin } from './auth.js';
import {
  assertApplywizzZohoConnected,
  resolveApplywizzIdFromApplicationRef,
} from '../../db/zohoConnected.js';
import {
  getSignedProofUrl,
  downloadProofBuffer,
  PROOFS_BUCKET,
  PROOFS_FAILED_BUCKET,
  PROOFS_MAIL_BUCKET,
  webProofStoragePath,
  failedProofStoragePath,
  emailProofStoragePath,
  isApplicationUuid,
} from '../../db/storage.js';
import { createLogger } from '../../utils/logger.js';
import { insertAuditEvent, SUBMIT_CLICK_AUDIT_ACTION } from '../../db/events.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { resolveRole } from './auth.js';

const log = createLogger('Submissions');

export const submissionsRouter = Router();

/** Operator-facing accept for submission-gate blocks (no queue write; same JSON as a real queue). */
function respondEligibilityBlockedAsQueued(res: Response, appId: string): void {
  res.status(200).json({
    success: true,
    status: 'QUEUED',
    applicationId: appId,
    message: 'Application queued for submission.',
  });
}

async function ensureZohoConnectedForApplication(
  req: Request,
  res: Response,
  appId: string
): Promise<boolean> {
  const user = (req as any).user;
  const userEmail = (user?.email || '').trim().toLowerCase();
  const isAdmin = isUserAdmin(user || userEmail);
  const jobUrl = req.body?.jobUrl;

  const applywizzId = await resolveApplywizzIdFromApplicationRef(appId, jobUrl);
  if (!applywizzId) {
    res.status(404).json({
      success: false,
      error: `Could not resolve candidate for application '${appId}'.`,
    });
    return false;
  }

  const gate = await assertApplywizzZohoConnected(applywizzId, { isAdmin, allowAdminDemo: true });
  if (!gate.allowed) {
    res.status(403).json({ success: false, error: gate.error });
    return false;
  }

  return true;
}

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  '#submit_app',
  'button:has-text("Submit Application")',
  'input[value*="Submit"]',
  'button:has-text("Apply")',
  '#submit_application',
];

async function closePausedSession(applicationId: string): Promise<void> {
  await clearPausedSession(applicationId);
  log.info(`[Submissions Router] 🧹 Cleaned up paused session for application ${applicationId}`);
}

function getWorkerServiceUrl(): string {
  if (process.env.ENABLE_QUEUE_WORKER === 'true') {
    return ''; // Worker service itself executes in-process
  }
  return (process.env.WORKER_SERVICE_URL || config.WORKER_SERVICE_URL || '').trim().replace(/\/+$/, '');
}

async function proxyToWorker(
  req: Request,
  res: Response,
  targetPath: string
): Promise<boolean> {
  const workerUrl = getWorkerServiceUrl();
  if (!workerUrl) {
    return false; // Fall back to local execution
  }

  const fullUrl = `${workerUrl}${targetPath}`;
  log.info(`[Submissions Router] 🔀 Proxying ${req.method} ${targetPath} to worker at ${fullUrl}`);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (req.headers.authorization) {
      headers.authorization = req.headers.authorization;
    }
    if (req.headers.cookie) {
      headers.cookie = req.headers.cookie;
    }
    if (req.headers['x-view-as']) {
      headers['x-view-as'] = String(req.headers['x-view-as']);
    }
    if (req.headers['x-view-as-manager-email']) {
      headers['x-view-as-manager-email'] = String(req.headers['x-view-as-manager-email']);
    }
    const userEmail = (req as any).user?.email || req.body?.assignedCaEmail;
    if (userEmail) {
      headers['x-user-email'] = String(userEmail);
    }
    if ((req as any).user?.role) {
      headers['x-user-role'] = String((req as any).user.role);
    }
    if (process.env.INTERNAL_API_SECRET) {
      headers['x-internal-secret'] = process.env.INTERNAL_API_SECRET;
    }

    const response = await axios({
      method: req.method as any,
      url: fullUrl,
      headers,
      params: req.query,
      data: req.body,
      validateStatus: () => true, // Pipe all status codes through
      timeout: 120000,
    });

    if (response.status >= 400) {
      log.error('[Submissions] Proxy to worker failed', {
        url: fullUrl,
        status: response.status,
        body: response.data,
      });
    }

    res.status(response.status).json(response.data);
    return true;
  } catch (err: any) {
    log.error('[Submissions] Proxy to worker failed', {
      url: fullUrl,
      status: err.response?.status || 502,
      body: err.response?.data || err.message,
    });
    res.status(err.response?.status || 502).json(
      err.response?.data || {
        success: false,
        error: `Failed to proxy request to worker service: ${err.message}`,
      }
    );
    return true;
  }
}

/**
 * POST /api/applications/:id/dry-run
 * Executes a headful dry-run for the specified application.
 */
submissionsRouter.post('/:id/dry-run', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const userEmail = (req as any).user?.email || req.body?.assignedCaEmail || 'anonymous';
  log.info(`[Submissions Router] 🎬 POST /api/applications/${appId}/dry-run requested by ${userEmail}`);

  if (await proxyToWorker(req, res, `/api/applications/${encodeURIComponent(appId)}/dry-run`)) {
    return;
  }

  if (!(await ensureZohoConnectedForApplication(req, res, appId))) {
    return;
  }

  try {
    const result = await runDryRun(appId, {
      headless: req.body?.headless !== undefined ? req.body.headless : undefined,
      timeoutMs: req.body?.timeoutMs ?? 30000,
      jobUrl: req.body?.jobUrl,
    });

    if (result.success) {
      log.info(`[Submissions Router] ✅ Dry-run succeeded for ${appId} (screenshot: ${result.screenshotUrl})`);
      res.status(200).json({
        success: true,
        applicationId: result.applicationId,
        screenshotUrl: result.screenshotUrl,
        summary: result.summary,
      });
    } else {
      log.error(`[Submissions Router] ❌ Dry-run failed for ${appId}: ${result.error}`);
      res.status(500).json({
        success: false,
        applicationId: result.applicationId,
        error: result.error || 'Dry-run failed.',
        summary: result.summary,
      });
    }
  } catch (err: unknown) {
    log.error(`[Submissions Router] ❌ Dry-run route error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/applications/:id/submit
 * Triggers a live automated submission with CAPTCHA detection.
 */
submissionsRouter.post('/:id/submit', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const isSync = req.query.sync === 'true' || req.body?.sync === true;
  const userEmail = (req as any).user?.email || req.body?.assignedCaEmail || undefined;
  log.info(
    `[Submissions Router] 🚀 POST /api/applications/${appId}/submit requested by ${userEmail || 'anonymous'} (isSync: ${isSync}, jobUrl: ${req.body?.jobUrl || 'auto'})`
  );

  void insertAuditEvent({
    actorEmail: userEmail,
    actorRole: resolveRole((req as any).user || userEmail),
    action: SUBMIT_CLICK_AUDIT_ACTION,
    targetType: 'application',
    targetId: appId,
    metadata: {
      jobUrl: req.body?.jobUrl || null,
      sync: isSync,
    },
  });

  if (await proxyToWorker(req, res, `/api/applications/${encodeURIComponent(appId)}/submit`)) {
    return;
  }

  if (!(await ensureZohoConnectedForApplication(req, res, appId))) {
    return;
  }

  const appRow = await getApplication(appId, req.body?.jobUrl);
  if (appRow) {
    const isAdmin = ['admin', 'dev'].includes((req as any).user?.role);
    if (
      !isAdmin &&
      (req as any).user?.email &&
      appRow.assigned_ca_email !== null &&
      appRow.assigned_ca_email !== undefined &&
      appRow.assigned_ca_email.trim().toLowerCase() !==
        String((req as any).user.email).trim().toLowerCase()
    ) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  }

  // Asynchronous queue insertion (default production flow - Phase V2-4c)
  if (!isSync) {
    log.info(`[API] Submit endpoint received → setting status to: QUEUED`);
    try {
      const { submissionOrder, application } = await enqueueApplication(appId, {
        assignedCaEmail: userEmail,
        jobUrl: req.body?.jobUrl,
      });

      log.info(`[API] Submit clicked → status = QUEUED (ready for queue daemon)`);
      log.info(
        `[Submissions Router] 📥 Application ${application.id || appId} queued (submission_order: ${submissionOrder}, ca: ${userEmail || 'none'})`
      );
      log.info(
        `[API] Status → QUEUED (application ${application.id || appId}, submission_order=${submissionOrder})`
      );

      res.status(200).json({
        success: true,
        status: 'QUEUED',
        applicationId: application.id || appId,
        submissionOrder,
        message: `Application queued for submission (Order: ${submissionOrder}).`,
      });
      return;
    } catch (err: unknown) {
      const errObj = err as { name?: string; message?: string };
      if (errObj?.name === 'SubmissionEligibilityBlockedError') {
        log.warn(`[Submissions Router] Submission gate blocked ${appId}: ${errObj.message}`);
        respondEligibilityBlockedAsQueued(res, appId);
        return;
      }
      log.error(`[Submissions Router] ❌ Enqueue error for ${appId}:`, err);
      res.status(500).json({
        success: false,
        status: 'FAILED',
        error: 'Internal server error',
      });
      return;
    }
  }

  // Synchronous execution fallback (when ?sync=true)
  try {
    const result = await runLiveSubmit(appId, {
      headless: req.body?.headless !== undefined ? req.body.headless : true,
      timeoutMs: req.body?.timeoutMs ?? 30000,
      jobUrl: req.body?.jobUrl,
    });

    if (result.status === 'APPLIED') {
      await updateStatus(appId, 'APPLIED', {
        proof_web_url: result.proofWebUrl,
        proof_captured_at: result.proofCapturedAt,
        job_url: req.body?.jobUrl,
      }).catch(() => {});

      res.status(200).json({
        success: true,
        status: result.status,
        applicationId: result.applicationId,
        proofWebUrl: result.proofWebUrl,
        proofCapturedAt: result.proofCapturedAt,
        summary: result.summary,
      });
    } else if (result.status === 'EMAIL_PROOF_PENDING') {
      res.status(200).json({
        success: true,
        status: 'EMAIL_PROOF_PENDING',
        applicationId: result.applicationId,
        proofWebUrl: result.proofWebUrl,
        proofCapturedAt: result.proofCapturedAt,
        message: 'Web submission confirmed. Polling Zoho Mail for confirmation email proof (up to 10 minutes).',
        summary: result.summary,
      });
    } else if (result.status === 'OTP_REQUIRED') {
      res.status(202).json({
        success: false,
        status: result.status,
        applicationId: result.applicationId,
        requiresOtp: true,
        requiresCaptcha: result.requiresOtp ?? result.requiresCaptcha,
        message: 'CAPTCHA or OTP challenge detected after submit. Please solve manually in the browser and call /resume-submission.',
        summary: result.summary,
      });
    } else if (result.status === 'QUEUED') {
      const retryCount = result.retryReason === 'OTP_FETCH_FAIL'
        ? (await getApplication(appId, req.body?.jobUrl))?.retry_count ?? 0
        : undefined;
      res.status(202).json({
        success: false,
        status: 'QUEUED',
        applicationId: result.applicationId,
        retryCount,
        message: retryCount ? `Retrying submission (${retryCount}/3).` : 'Submission queued for retry.',
        summary: result.summary,
      });
    } else {
      const failReason = result.errorMessage || 'Submission failed.';
      const retryReason = getRetryReason(result);
      if (retryReason) {
        const retry = await requeueApplicationForRetry(appId, retryReason, req.body?.jobUrl);
        if (retry.requeued) {
          res.status(202).json({
            success: false,
            status: 'QUEUED',
            applicationId: result.applicationId,
            retryCount: retry.retryCount,
            message: `Retrying submission (${retry.retryCount}/3).`,
            summary: result.summary,
          });
          return;
        }
      }
      await updateStatus(appId, (result.status as any) || 'FAILED', {
        error_message: failReason,
        proof_failed_url: result.proofFailedUrl,
        proof_failed_captured_at: result.proofFailedCapturedAt,
        job_url: req.body?.jobUrl,
      }).catch(() => {});

      res.status(500).json({
        success: false,
        status: result.status,
        applicationId: result.applicationId,
        error: failReason,
        proofFailedUrl: result.proofFailedUrl,
        proofFailedCapturedAt: result.proofFailedCapturedAt,
        summary: result.summary,
      });
    }
  } catch (err: unknown) {
    const errObj = err as { name?: string; message?: string };
    if (errObj?.name === 'SubmissionEligibilityBlockedError') {
      log.warn(`[Submissions Router] Submission gate blocked ${appId}: ${errObj.message}`);
      respondEligibilityBlockedAsQueued(res, appId);
      return;
    }
    const retryReason = getRetryReason(err instanceof Error ? err : String(err));
    if (retryReason) {
      const retry = await requeueApplicationForRetry(appId, retryReason, req.body?.jobUrl);
      if (retry.requeued) {
        res.status(202).json({
          success: false,
          status: 'QUEUED',
          applicationId: appId,
          retryCount: retry.retryCount,
          message: `Retrying submission (${retry.retryCount}/3).`,
        });
        return;
      }
    }
    const errMessage = err instanceof Error ? err.message : String(err);
    log.error(`[Submissions Router] ❌ Submit route error for ${appId}:`, err);
    await updateStatus(appId, 'FAILED', {
      error_message: errMessage || 'Unexpected submit route error',
      job_url: req.body?.jobUrl,
    }).catch(() => {});

    res.status(500).json({
      success: false,
      status: 'FAILED',
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/applications/:id/open-captcha-session
 * Opens a headful Playwright browser for the paused CAPTCHA session so the operator can solve it manually.
 */
submissionsRouter.post('/:id/open-captcha-session', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const timeoutMs = req.body?.timeoutMs ?? 30000;

  try {
    const application = await getApplication(appId, req.body?.jobUrl);
    if (!application) {
      res.status(404).json({
        success: false,
        error: `Application '${appId}' not found.`,
      });
      return;
    }

    const targetUrl = application.job_url;
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      res.status(400).json({ error: 'Invalid job URL' });
      return;
    }
    const isGreenhouse = /(^|\.)greenhouse\.io$/i.test(url.hostname) || url.hostname === 'grnh.se';
    if (!isGreenhouse) {
      res.status(400).json({ error: 'Invalid job URL' });
      return;
    }

    if (await proxyToWorker(req, res, `/api/applications/${encodeURIComponent(appId)}/open-captcha-session`)) {
      return;
    }

    const hadExistingSession = Boolean(resolvePausedSession(appId));
    await closePausedSession(appId);

    let browser: any = null;
    let context: any = null;
    let page: any = null;

    try {
      browser = await chromium.launch({
        headless: false,
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

      log.info(
        `[Submissions Router] 🌐 Opening headful CAPTCHA browser for ${application.applywizz_id} → ${targetUrl}`
      );
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      await fillForm(page, application, {
        minJitterMs: 300,
        maxJitterMs: 800,
        timeoutMs: 5000,
      });
      await page.waitForTimeout(500);

      const sessionKey = storePausedSession(application, {
        browser,
        page,
        jobUrl: targetUrl,
        requiresOtp: false,
      });

      registerSubmissionSession({
        applicationId: sessionKey,
        browser,
        context,
        page,
        application,
        startedAt: Date.now(),
      });

      if (application.id) {
        await updateStatus(application.id, 'OTP_REQUIRED');
      }

      res.status(200).json({
        status: 'BROWSER_OPENED',
        applicationId: sessionKey,
        recreated: !hadExistingSession,
      });
    } catch (innerErr: any) {
      if (page && !page.isClosed()) {
        await captureFailedScreenshot(page, application).catch(() => {});
        await page.close().catch(() => {});
      }
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      throw innerErr;
    }
  } catch (err: unknown) {
    log.error(`[Submissions Router] ❌ Open CAPTCHA session route error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/applications/:id/submit-otp
 * Fills the OTP field on a paused session, submits verification, and completes if confirmed.
 */
submissionsRouter.post('/:id/submit-otp', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const otp = req.body?.otp;
  const timeoutMs = req.body?.timeoutMs ?? 30000;

  if (!otp || typeof otp !== 'string' || !otp.trim()) {
    res.status(400).json({
      success: false,
      error: 'Missing required body field: otp (string).',
    });
    return;
  }

  if (await proxyToWorker(req, res, `/api/internal/applications/${encodeURIComponent(appId)}/submit-otp`)) {
    return;
  }

  const pausedSession = resolvePausedSession(appId);
  if (!pausedSession) {
    res.status(404).json({
      success: false,
      error: 'No paused OTP session',
    });
    return;
  }

  try {
    const result = await submitOtpToPausedSession(appId, otp, {
      timeoutMs,
      jobUrl: req.body?.jobUrl,
    });

    if (result.status === 'APPLIED') {
      await updateStatus(appId, 'APPLIED', {
        proof_web_url: result.proofUrl || result.proofWebUrl,
        proof_captured_at: result.proofCapturedAt,
        job_url: req.body?.jobUrl,
      }).catch(() => {});

      res.status(200).json({
        status: 'APPLIED',
        proofUrl: result.proofUrl,
        proofWebUrl: result.proofWebUrl,
        proofCapturedAt: result.proofCapturedAt,
        applicationId: result.applicationId,
        message: 'Application submitted successfully',
      });
      return;
    }

    const otpFailReason = result.errorMessage || 'OTP submission failed.';
    await updateStatus(appId, 'FAILED', {
      error_message: otpFailReason,
      proof_failed_url: result.proofFailedUrl,
      proof_failed_captured_at: result.proofFailedCapturedAt,
      job_url: req.body?.jobUrl,
    }).catch(() => {});

    res.status(200).json({
      status: 'FAILED',
      applicationId: result.applicationId,
      error: otpFailReason,
      proofFailedUrl: result.proofFailedUrl,
      proofFailedCapturedAt: result.proofFailedCapturedAt,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.error(`[Submissions Router] ❌ Submit OTP route error for ${appId}:`, err);

    const isMissingSession = /no paused.*session/i.test(errMessage);
    if (isMissingSession) {
      res.status(404).json({
        success: false,
        error: 'No paused OTP session',
      });
      return;
    }

    await updateStatus(appId, 'FAILED', {
      error_message: errMessage || 'OTP submission failed.',
      job_url: req.body?.jobUrl,
    }).catch(() => {});

    res.status(200).json({
      status: 'FAILED',
      applicationId: appId,
      error: errMessage || 'OTP submission failed.',
    });
  }
});

/**
 * POST /api/applications/:id/resume-submission
 * Resumes a submission paused at OTP_REQUIRED after operator manual CAPTCHA/OTP resolution.
 */
submissionsRouter.post('/:id/resume-submission', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const timeoutMs = req.body?.timeoutMs ?? 30000;

  if (await proxyToWorker(req, res, `/api/internal/applications/${encodeURIComponent(appId)}/resume-submission`)) {
    return;
  }

  try {
    const resolvedSession = resolvePausedSession(appId);
    if (!resolvedSession) {
      res.status(404).json({
        success: false,
        error: `No paused CAPTCHA session found for application '${appId}'. Click "Open Browser for CAPTCHA" first.`,
      });
      return;
    }

    const application = await getApplication(appId, req.body?.jobUrl);
    if (!application) {
      res.status(404).json({
        success: false,
        error: `Application '${appId}' not found.`,
      });
      return;
    }

    const { page } = resolvedSession.session;
    const sessionKey = resolvedSession.canonicalKey;

    log.info(`[Submissions Router] ▶️ Resuming submission for application ${sessionKey}...`);

    if (application.id) {
      await updateStatus(application.id, 'APPLYING');
    }

    let submitClicked = false;
    for (const sel of SUBMIT_SELECTORS) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ timeout: 5000 });
        submitClicked = true;
        log.info(`[Submissions Router] 🖱️ Clicked submit button (${sel})`);
        break;
      }
    }

    if (!submitClicked) {
      const errorMsg = 'Submit button not found or not visible on resumed page.';
      let failedProof: any = null;
      if (page && !page.isClosed()) {
        failedProof = await captureFailedScreenshot(page, application || sessionKey).catch(() => null);
      }
      if (application.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: errorMsg,
          proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
          proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
          job_url: application.job_url,
        });
      }
      await closePausedSession(sessionKey);
      res.status(500).json({
        success: false,
        status: 'FAILED',
        applicationId: sessionKey,
        error: errorMsg,
        proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
        proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
      });
      return;
    }

    const verification = await verifySubmissionSignals(page, timeoutMs);

    if (verification.verified) {
      log.info(`[Submissions Router] ✅ Confirmation verified via signal: ${verification.signal}`);

      const proofResult = await captureWebProof(page, application);

      if (application.id) {
        await updateStatus(application.id, 'APPLIED');
      }

      await closePausedSession(sessionKey);

      res.status(200).json({
        success: true,
        status: 'APPLIED',
        applicationId: sessionKey,
        proofWebUrl: proofResult.proofWebUrl,
        proofCapturedAt: proofResult.proofCapturedAt,
      });
      return;
    }

    const errorMsg =
      verification.error || 'Submission confirmation signals not detected within 30 seconds.';
    log.warn(`[Submissions Router] ❌ Verification failed: ${errorMsg}`);

    let failedProof: any = null;
    if (page && !page.isClosed()) {
      failedProof = await captureFailedScreenshot(page, application || sessionKey).catch(() => null);
    }

    if (application.id) {
      await updateStatus(application.id, 'FAILED', {
        error_message: errorMsg,
        proof_failed_url: failedProof?.proofFailedUrl || failedProof?.url,
        proof_failed_captured_at: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
        job_url: application.job_url,
      });
    }

    await closePausedSession(sessionKey);

    res.status(500).json({
      success: false,
      status: 'FAILED',
      applicationId: sessionKey,
      error: errorMsg,
      proofFailedUrl: failedProof?.proofFailedUrl || failedProof?.url,
      proofFailedCapturedAt: failedProof?.proofFailedCapturedAt || failedProof?.capturedAt,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.error(`[Submissions Router] ❌ Resume route error for ${appId}:`, err);

    let errProof: Awaited<ReturnType<typeof captureFailedScreenshot>> | null = null;
    try {
      const resolved = resolvePausedSession(appId);
      if (resolved?.session?.page && !resolved.session.page.isClosed()) {
        errProof = await captureFailedScreenshot(resolved.session.page, appId).catch(() => null);
      }
    } catch {}

    try {
      const application = await getApplication(appId, req.body?.jobUrl);
      if (application?.id) {
        await updateStatus(application.id, 'FAILED', {
          error_message: errMessage,
          proof_failed_url: errProof?.proofFailedUrl || errProof?.url,
          proof_failed_captured_at: errProof?.proofFailedCapturedAt || errProof?.capturedAt,
          job_url: application.job_url,
        });
      }
    } catch {}

    await closePausedSession(appId);

    res.status(500).json({
      success: false,
      status: 'FAILED',
      error: 'Internal server error',
      proofFailedUrl: errProof?.proofFailedUrl || errProof?.url,
      proofFailedCapturedAt: errProof?.proofFailedCapturedAt || errProof?.capturedAt,
    });
  }
});

/**
 * POST /api/applications/:id/capture-email-proof
 * Manually retries capturing confirmation email proof screenshot from Zoho Reader.
 */
submissionsRouter.post('/:id/capture-email-proof', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const jobUrl = req.body?.jobUrl;

  try {
    const app = await getApplication(appId, jobUrl);
    if (!app) {
      res.status(404).json({ success: false, error: `Application '${appId}' not found.` });
      return;
    }

    if (!app.proof_web_url) {
      res.status(400).json({
        success: false,
        error: 'Cannot capture email proof: web confirmation proof is missing.',
      });
      return;
    }

    if (app.proof_email_json) {
      const json = app.proof_email_json;
      res.status(200).json({
        success: true,
        alreadyCaptured: true,
        proofEmailJson: json,
        proof_email_json: json,
        proofEmailCapturedAt: app.proof_email_captured_at,
        emailProofStatus: 'captured',
      });
      return;
    }

    if (app.proof_email_url) {
      res.status(200).json({
        success: true,
        alreadyCaptured: true,
        legacyScreenshotOnly: true,
        proofEmailUrl: app.proof_email_url,
        proofEmailCapturedAt: app.proof_email_captured_at,
        emailProofStatus: 'captured',
      });
      return;
    }

    if (app.email_proof_status === 'pending') {
      res.status(409).json({
        success: false,
        error: 'Automatic email proof capture is currently in progress. Please wait.',
      });
      return;
    }

    log.info(`[Submissions Router] 📧 Manual email proof capture triggered for ${appId}`);
    const emailJson = await captureAndSaveEmailProof(app, {
      timeoutMs: req.body?.timeoutMs ?? 45000,
      isManual: true,
    });

    if (emailJson) {
      // Stop background poller since manual search succeeded
      emailProofPoller.stopPolling(appId);
      if (app.id) emailProofPoller.stopPolling(app.id);

      // Promote status to APPLIED if it was pending confirmation email
      await updateStatus(app.id || appId, 'APPLIED', {
        proof_email_json: emailJson,
        proof_email_captured_at: emailJson.received_at || new Date().toISOString(),
        email_proof_status: 'captured',
        job_url: app.job_url,
      });

      const updated = await getApplication(appId, jobUrl);
      res.status(200).json({
        success: true,
        status: 'APPLIED',
        proofEmailJson: emailJson,
        proof_email_json: emailJson,
        proofEmailCapturedAt: updated?.proof_email_captured_at || new Date().toISOString(),
        emailProofStatus: 'captured',
      });
    } else {
      res.status(422).json({
        success: false,
        error: 'Confirmation email not found in Zoho Mail inbox yet. If you recently submitted, please allow 1-2 minutes for email delivery and try again.',
        emailProofStatus: 'timed_out',
      });
    }
  } catch (err: unknown) {
    log.error(`[Submissions Router] ❌ Capture email proof error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/applications/:id/proof-url?kind=web|failed|dryrun|email
 * Returns a fresh signed URL for a private proof object (for dashboard <img> tags).
 */
submissionsRouter.get('/:id/proof-url', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const jobUrl =
    (typeof req.query.jobUrl === 'string' ? req.query.jobUrl : '') ||
    (typeof req.query.job_url === 'string' ? req.query.job_url : '');
  const kind = String(req.query.kind || 'web').toLowerCase();

  try {
    let app = await getApplication(appId, jobUrl);
    if (!app && isApplicationUuid(appId)) {
      app = await getApplication(appId);
    }

    let storageKey: string | null = null;
    if (app?.id && isApplicationUuid(app.id)) {
      storageKey = app.id;
    } else if (isApplicationUuid(appId)) {
      storageKey = appId;
    } else if (app?.applywizz_id && (jobUrl || app?.job_url)) {
      try {
        const dbApp = await getApplicationByCandidateAndJob(app.applywizz_id, jobUrl || app.job_url);
        if (dbApp?.id && isApplicationUuid(dbApp.id)) {
          storageKey = dbApp.id;
          if (!app) app = dbApp;
        }
      } catch {}
    }

    if (!storageKey) {
      storageKey = app?.id || appId || null;
    }

    if (!storageKey) {
      res.status(400).json({ error: 'Application record identifier missing; cannot resolve storage proof path.' });
      return;
    }

    let bucket = PROOFS_BUCKET;
    let objectPath = webProofStoragePath(storageKey);
    if (kind === 'failed') {
      bucket = PROOFS_FAILED_BUCKET;
      objectPath = failedProofStoragePath(storageKey);
    } else if (kind === 'email' || kind === 'mail') {
      bucket = PROOFS_MAIL_BUCKET;
      objectPath = emailProofStoragePath(storageKey);
    } else if (kind === 'dryrun' || kind === 'dry_run') {
      bucket = 'proofs_dry_run';
      objectPath = `dry-run/${storageKey}_dryrun.png`;
    } else if (kind !== 'web') {
      res.status(400).json({ error: `Invalid kind '${kind}'. Use web, failed, dryrun, or email.` });
      return;
    }

    const expiresIn = 86400;
    let signedUrl = await getSignedProofUrl(bucket, objectPath, expiresIn);

    // Fallback: if not found under storageKey and candidate has applywizz_id, try that path
    if (!signedUrl && app?.applywizz_id && storageKey !== app.applywizz_id) {
      let altPath = webProofStoragePath(app.applywizz_id);
      if (kind === 'failed') altPath = failedProofStoragePath(app.applywizz_id);
      else if (kind === 'email' || kind === 'mail') altPath = emailProofStoragePath(app.applywizz_id);
      else if (kind === 'dryrun' || kind === 'dry_run') altPath = `dry-run/${app.applywizz_id}_dryrun.png`;
      signedUrl = await getSignedProofUrl(bucket, altPath, expiresIn);
    }

    if (!signedUrl) {
      res.status(404).json({ error: `No signed URL available for ${kind} proof.` });
      return;
    }

    res.status(200).json({
      kind: kind === 'mail' ? 'email' : kind,
      url: signedUrl,
      expiresIn,
      applicationId: app?.id || storageKey,
    });
  } catch (err: unknown) {
    log.error(`[Submissions Router] ❌ proof-url error for ${appId}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/applications/:id/proof-image?kind=web|failed|dryrun|email&jobUrl=...
 * Proxies and streams the proof image directly to the client (immune to client CORS or token expiry).
 */
submissionsRouter.get('/:id/proof-image', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const jobUrl =
    (typeof req.query.jobUrl === 'string' ? req.query.jobUrl : '') ||
    (typeof req.query.job_url === 'string' ? req.query.job_url : '');
  const kind = String(req.query.kind || 'web').toLowerCase();
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';

  if (!(req as any).user && queryToken && isSupabaseConfigured()) {
    try {
      const supabase = getDbClient();
      const { data, error } = await supabase.auth.getUser(queryToken);
      if (!error && data?.user) {
        (req as any).user = data.user;
      }
    } catch {}
  }

  try {
    let app = await getApplication(appId, jobUrl);
    if (!app && isApplicationUuid(appId)) {
      app = await getApplication(appId);
    }

    let storageKey: string | null = null;
    if (app?.id && isApplicationUuid(app.id)) {
      storageKey = app.id;
    } else if (isApplicationUuid(appId)) {
      storageKey = appId;
    } else if (app?.applywizz_id && (jobUrl || app?.job_url)) {
      try {
        const dbApp = await getApplicationByCandidateAndJob(app.applywizz_id, jobUrl || app.job_url);
        if (dbApp?.id && isApplicationUuid(dbApp.id)) {
          storageKey = dbApp.id;
          if (!app) app = dbApp;
        }
      } catch {}
    }

    if (!storageKey) {
      storageKey = app?.id || appId || null;
    }

    if (!storageKey) {
      res.status(400).json({ error: 'Application record identifier missing.' });
      return;
    }

    let bucket = PROOFS_BUCKET;
    let objectPath = webProofStoragePath(storageKey);
    if (kind === 'failed') {
      bucket = PROOFS_FAILED_BUCKET;
      objectPath = failedProofStoragePath(storageKey);
    } else if (kind === 'email' || kind === 'mail') {
      bucket = PROOFS_MAIL_BUCKET;
      objectPath = emailProofStoragePath(storageKey);
    } else if (kind === 'dryrun' || kind === 'dry_run') {
      bucket = 'proofs_dry_run';
      objectPath = `dry-run/${storageKey}_dryrun.png`;
    }

    let buffer = await downloadProofBuffer(bucket, objectPath);
    if (!buffer && app?.applywizz_id && storageKey !== app.applywizz_id) {
      let altPath = webProofStoragePath(app.applywizz_id);
      if (kind === 'failed') altPath = failedProofStoragePath(app.applywizz_id);
      else if (kind === 'email' || kind === 'mail') altPath = emailProofStoragePath(app.applywizz_id);
      else if (kind === 'dryrun' || kind === 'dry_run') altPath = `dry-run/${app.applywizz_id}_dryrun.png`;
      buffer = await downloadProofBuffer(bucket, altPath);
    }

    if (!buffer) {
      res.status(404).json({ error: `Proof image not found for ${kind}.` });
      return;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(buffer);
  } catch (err: unknown) {
    log.error(`[Submissions Router] ❌ proof-image error for ${appId}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/applications/:id/proof
 * Retrieves proof screenshot URL and capture metadata for an application.
 */
submissionsRouter.get('/:id/proof', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const jobUrl =
    (typeof req.query.jobUrl === 'string' ? req.query.jobUrl : '') ||
    (typeof req.query.job_url === 'string' ? req.query.job_url : '');

  try {
    let app = await getApplication(appId, jobUrl);
    if (!app && isApplicationUuid(appId)) {
      app = await getApplication(appId);
    }
    if (!app) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }

    app = await hydrateApplicationProofUrls(app);

    if (!app.proof_web_url) {
      res.status(404).json({
        error: `No confirmation proof screenshot available for application '${appId}'.`,
        status: app.status,
      });
      return;
    }

    res.status(200).json({
      applicationId: app.id,
      applywizzId: app.applywizz_id,
      jobUrl: app.job_url,
      status: app.status,
      proofWebUrl: app.proof_web_url,
      proofCapturedAt: app.proof_captured_at,
      proofEmailUrl: app.proof_email_url,
      proofEmailCapturedAt: app.proof_email_captured_at,
      emailProofStatus: app.email_proof_status || (app.proof_email_url ? 'captured' : (app.proof_web_url ? 'timed_out' : null)),
      emailProofAttemptedAt: app.email_proof_attempted_at,
    });
  } catch (err: unknown) {
    log.error(`[Submissions Router] ❌ Proof route error for ${appId}:`, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default submissionsRouter;
