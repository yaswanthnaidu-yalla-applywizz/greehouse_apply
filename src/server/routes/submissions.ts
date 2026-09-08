/**
 * @fileoverview Express Router for Application Submissions, Dry-Runs, and Proofs (Phase V2-4).
 *
 * Endpoints:
 * - POST /api/applications/:id/dry-run: Triggers headful dry-run form filling and captures screenshot
 * - POST /api/applications/:id/submit: Triggers live automated submission with CAPTCHA check
 * - POST /api/applications/:id/resume-submission: Resumes paused submission after manual CAPTCHA solving
 * - GET  /api/applications/:id/proof: Retrieves web proof screenshot URL and timestamp
 */

import { Router, Request, Response } from 'express';
import { runDryRun } from '../../submitter/dryRun.js';
import { runLiveSubmit } from '../../submitter/liveSubmit.js';
import { resumeSubmission } from '../../submitter/captchaResume.js';
import { getApplication } from '../../db/applications.js';

export const submissionsRouter = Router();

/**
 * POST /api/applications/:id/dry-run
 * Executes a headful dry-run for the specified application.
 */
submissionsRouter.post('/:id/dry-run', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');

  try {
    const result = await runDryRun(appId, {
      headless: req.body?.headless !== undefined ? req.body.headless : false,
      timeoutMs: req.body?.timeoutMs ?? 30000,
    });

    if (result.success) {
      res.status(200).json({
        success: true,
        applicationId: result.applicationId,
        screenshotUrl: result.screenshotUrl,
        summary: result.summary,
      });
    } else {
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

  try {
    const result = await runLiveSubmit(appId, {
      headless: req.body?.headless !== undefined ? req.body.headless : true,
      timeoutMs: req.body?.timeoutMs ?? 30000,
    });

    if (result.status === 'APPLIED') {
      res.status(200).json({
        success: true,
        status: result.status,
        applicationId: result.applicationId,
        proofWebUrl: result.proofWebUrl,
        summary: result.summary,
      });
    } else if (result.status === 'CAPTCHA_REQUIRED') {
      res.status(202).json({
        success: false,
        status: result.status,
        applicationId: result.applicationId,
        requiresCaptcha: true,
        message: 'CAPTCHA challenge detected. Please solve manually in the browser and call /resume-submission.',
        summary: result.summary,
      });
    } else {
      res.status(500).json({
        success: false,
        status: result.status,
        applicationId: result.applicationId,
        error: result.errorMessage || 'Submission failed.',
        summary: result.summary,
      });
    }
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Submit route error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      status: 'FAILED',
      error: err.message,
    });
  }
});

/**
 * POST /api/applications/:id/resume-submission
 * Resumes a submission paused at CAPTCHA_REQUIRED after operator manual solution.
 */
submissionsRouter.post('/:id/resume-submission', async (req: Request, res: Response): Promise<void> => {
  const rawId = req.params.id;
  const appId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');

  try {
    const result = await resumeSubmission(appId);

    if (result.success) {
      res.status(200).json({
        success: true,
        status: result.status,
        applicationId: result.applicationId,
        proofWebUrl: result.proofWebUrl,
      });
    } else {
      res.status(500).json({
        success: false,
        status: result.status,
        applicationId: result.applicationId,
        error: result.errorMessage || 'Failed to resume submission.',
      });
    }
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Resume route error for ${appId}:`, err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
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
    const app = await getApplication(appId);
    if (!app) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }

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
    });
  } catch (err: any) {
    console.error(`[Submissions Router] ❌ Proof route error for ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default submissionsRouter;
