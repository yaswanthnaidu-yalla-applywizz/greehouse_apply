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
import { getApplication, updateStatus, enqueueApplication, hydrateApplicationProofUrls } from '../../db/applications.js';
import { isUserAdmin } from './auth.js';
import {
  assertApplywizzZohoConnected,
  resolveApplywizzIdFromApplicationRef,
} from '../../db/zohoConnected.js';
import {
  getSignedProofUrl,
  PROOFS_BUCKET,
  PROOFS_FAILED_BUCKET,
  PROOFS_MAIL_BUCKET,
  webProofStoragePath,
  failedProofStoragePath,
  emailProofStoragePath,
  isApplicationUuid,
} from '../../db/storage.js';

export const submissionsRouter = Router();

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
  console.log(`[Submissions Router] 🧹 Cleaned up paused session for application ${applicationId}`);
}

/**
 * POST /api/applications/:id/dry-run
 * Executes a headful dry-run for the specified application.
 */
submissionsRouter.post('/:id/dry-run', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
  const userEmail = (req as any).user?.email || req.body?.assignedCaEmail || 'anonymous';
  console.log(`[Submissions Router] 🎬 POST /api/applications/${appId}/dry-run requested by ${userEmail}`);

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
      console.log(`[Submissions Router] ✅ Dry-run succeeded for ${appId} (screenshot: ${result.screenshotUrl})`);
      res.status(200).json({
        success: true,
        applicationId: result.applicationId,
        screenshotUrl: result.screenshotUrl,
        summary: result.summary,
      });
    } else {
      console.error(`[Submissions Router] ❌ Dry-run failed for ${appId}: ${result.error}`);
      res.status(500).json({
        success: false,
        applicationId: result.applicationId,
        error: result.error || 'Dry-run failed.',
        summary: result.summary,
      });
    }
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Dry-run route error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: err.message,
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
  console.log(
    `[Submissions Router] 🚀 POST /api/applications/${appId}/submit requested by ${userEmail || 'anonymous'} (isSync: ${isSync}, jobUrl: ${req.body?.jobUrl || 'auto'})`
  );

  if (!(await ensureZohoConnectedForApplication(req, res, appId))) {
    return;
  }

  // Asynchronous queue insertion (default production flow - Phase V2-4c)
  if (!isSync) {
    try {
      const { submissionOrder, application } = await enqueueApplication(appId, {
        assignedCaEmail: userEmail,
        jobUrl: req.body?.jobUrl,
      });

      console.log(
        `[Submissions Router] 📥 Application ${application.id || appId} queued (submission_order: ${submissionOrder}, ca: ${userEmail || 'none'})`
      );
      console.log(`[API] POST /applications/${application.id || appId}/submit: status = QUEUED`);

      res.status(200).json({
        success: true,
        status: 'QUEUED',
        applicationId: application.id || appId,
        submissionOrder,
        message: `Application queued for submission (Order: ${submissionOrder}).`,
      });
      return;
    } catch (err: any) {
      console.error(`[Submissions Router] ❌ Enqueue error for ${appId}:`, err);
      res.status(500).json({
        success: false,
        status: 'FAILED',
        error: err.message || 'Failed to queue application.',
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
    } else {
      const failReason = result.errorMessage || 'Submission failed.';
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
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Submit route error for ${appId}:`, err);
    await updateStatus(appId, 'FAILED', {
      error_message: err.message || 'Unexpected submit route error',
      job_url: req.body?.jobUrl,
    }).catch(() => {});

    res.status(500).json({
      success: false,
      status: 'FAILED',
      error: err.message,
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
      const targetUrl = application.job_url;

      console.log(
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
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Open CAPTCHA session route error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: err.message,
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
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Submit OTP route error for ${appId}:`, err);

    const isMissingSession = /no paused.*session/i.test(err.message || '');
    if (isMissingSession) {
      res.status(404).json({
        success: false,
        error: 'No paused OTP session',
      });
      return;
    }

    await updateStatus(appId, 'FAILED', {
      error_message: err.message || 'OTP submission failed.',
      job_url: req.body?.jobUrl,
    }).catch(() => {});

    res.status(200).json({
      status: 'FAILED',
      applicationId: appId,
      error: err.message || 'OTP submission failed.',
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

    console.log(`[Submissions Router] ▶️ Resuming submission for application ${sessionKey}...`);

    if (application.id) {
      await updateStatus(application.id, 'APPLYING');
    }

    let submitClicked = false;
    for (const sel of SUBMIT_SELECTORS) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click({ timeout: 5000 });
        submitClicked = true;
        console.log(`[Submissions Router] 🖱️ Clicked submit button (${sel})`);
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
      console.log(`[Submissions Router] ✅ Confirmation verified via signal: ${verification.signal}`);

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
    console.warn(`[Submissions Router] ❌ Verification failed: ${errorMsg}`);

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
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Resume route error for ${appId}:`, err);

    let errProof: any = null;
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
          error_message: err.message,
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
      error: err.message,
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

    console.log(`[Submissions Router] 📧 Manual email proof capture triggered for ${appId}`);
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
        manual_email_review: false,
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
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Capture email proof error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to capture email proof.',
    });
  }
});

/**
 * GET /api/applications/:id/proof-url?kind=web|failed|email
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
    const app = await getApplication(appId, jobUrl);
    if (!app) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }

    const storageKey = app.id && isApplicationUuid(app.id) ? app.id : null;
    if (!storageKey) {
      res.status(400).json({ error: 'Application record has no UUID; cannot resolve storage proof path.' });
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
    } else if (kind !== 'web') {
      res.status(400).json({ error: `Invalid kind '${kind}'. Use web, failed, or email.` });
      return;
    }

    const expiresIn = 86400;
    const signedUrl = await getSignedProofUrl(bucket, objectPath, expiresIn);
    if (!signedUrl) {
      res.status(404).json({ error: `No signed URL available for ${kind} proof.` });
      return;
    }

    res.status(200).json({
      kind: kind === 'mail' ? 'email' : kind,
      url: signedUrl,
      expiresIn,
      applicationId: app.id,
    });
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ proof-url error for ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/applications/:id/proof
 * Retrieves proof screenshot URL and capture metadata for an application.
 */
submissionsRouter.get('/:id/proof', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');

  try {
    let app = await getApplication(appId);
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
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Proof route error for ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default submissionsRouter;
