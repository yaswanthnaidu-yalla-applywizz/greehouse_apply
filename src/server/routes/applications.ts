/**
 * @fileoverview Express Router for Candidate Applications and Field Modifications (V2).
 *
 * Endpoints:
 * - PATCH /api/applications/:id/fields/:fieldId: Modifies field value, updates DB, and saves to candidate_qa_bank (source: 'manual').
 * - GET /api/applications/:id: Retrieves single application record.
 */

import { Router, Request, Response } from 'express';
import {
  getApplication,
  updateResolvedFields,
  getRecentNotifications,
  upsertApplication,
  updateStatus,
  hydrateApplicationProofUrls,
  serializeApplicationDto,
  type ApplicationStatus,
} from '../../db/applications.js';
import { upsertAnswer } from '../../db/qaBank.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { generateFingerprint } from '../../resolver/fingerprint.js';
import { wsManager } from '../ws.js';
import { getAuthenticatedCaEmail } from '../workHistoryAuth.js';
import { isUserAdmin } from './auth.js';
import { getCachedWorkHistory, setCachedWorkHistory } from '../workHistoryCache.js';
import {
  fetchAllowedCandidates,
  fetchWorkHistoryForDate,
  getYesterdayIST,
} from '../../services/workHistoryClient.js';
import type { ResolvedField } from '../../types/index.js';

export const applicationsRouter = Router();

/**
 * PATCH /api/applications/:id/fields/:fieldId
 * Modifies an individual form field answer.
 *
 * Request Body:
 * { "value": "New manual answer", "jobUrl"?: "https://..." }
 *
 * Actions:
 * 1. Validates value
 * 2. Persists updated resolved_fields to Supabase via upsertApplication() and updateResolvedFields()
 * 3. Writes to candidate_qa_bank with source: 'manual'
 * 4. Returns the updated ResolvedField
 */
applicationsRouter.patch('/:id/fields/:fieldId', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const rawFieldId = req.params.fieldId;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');
  const fieldId = Array.isArray(rawFieldId) ? rawFieldId[0] : String(rawFieldId || '');

  const { value } = req.body;
  const reqJobUrl = (req.body?.jobUrl as string) || (req.query?.jobUrl as string) || (req.query?.job_url as string);

  if (typeof value !== 'string') {
    res.status(400).json({ error: 'Request body must contain a string "value".' });
    return;
  }

  const trimmedValue = value.trim();

  try {
    // 1. Fetch application
    let application: any = await getApplication(appId, reqJobUrl);

    if (!application && isSupabaseConfigured()) {
      const supabase = getDbClient();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId);
      let query = supabase.from('candidate_applications').select('*');
      if (isUuid) {
        query = query.eq('id', appId);
      } else {
        const candidateId = appId.includes('_') ? appId.split('_')[0] : appId;
        query = query.eq('applywizz_id', candidateId);
        if (reqJobUrl) query = query.eq('job_url', reqJobUrl);
      }
      const { data } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      application = data;
    }

    if (!application) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }

    // 2. Locate and update the target field in resolved_fields JSONB array
    const resolvedFields: ResolvedField[] = Array.isArray(application.resolved_fields)
      ? [...application.resolved_fields]
      : Array.isArray(application.resolvedFields)
      ? [...application.resolvedFields]
      : [];

    let targetFieldIndex = resolvedFields.findIndex(
      (f) => f.fieldId === fieldId || f.name === fieldId
    );

    let updatedField: ResolvedField;

    if (targetFieldIndex !== -1) {
      const existing = resolvedFields[targetFieldIndex];
      updatedField = {
        ...existing,
        value: trimmedValue,
        source: 'manual',
        isEdited: true,
        confidence: 1.0,
      };
      resolvedFields[targetFieldIndex] = updatedField;
    } else {
      // If field not yet present in snapshot, create it
      updatedField = {
        fieldId,
        name: fieldId,
        type: 'text',
        label: fieldId,
        value: trimmedValue,
        source: 'manual',
        resolvedByTier: 1,
        confidence: 1.0,
        isEdited: true,
      };
      resolvedFields.push(updatedField);
    }

    const targetJobUrl = reqJobUrl || application.job_url || application.jobUrl;
    const targetApplywizzId = application.applywizz_id || application.applywizzId || (appId.includes('_') ? appId.split('_')[0] : appId);

    // 3. Persist updated resolved_fields immediately to Supabase via upsertApplication()
    const savedApp = await upsertApplication({
      id: application.id,
      applywizz_id: targetApplywizzId,
      job_url: targetJobUrl,
      company_name: application.company_name || application.companyName,
      job_title: application.job_title || application.jobTitle,
      status: application.status || 'READY_FOR_REVIEW',
      resolved_fields: resolvedFields,
      has_manual_edits: true,
      reviewed_at: new Date().toISOString(),
    });

    // Also update resolved fields in DB
    await updateResolvedFields(savedApp.id || application.id, resolvedFields, {
      has_manual_edits: true,
      reviewed_at: new Date().toISOString(),
      job_url: targetJobUrl,
      applywizz_id: targetApplywizzId,
    });

    // 4. Save to candidate_qa_bank with source: 'manual' for persistent memory
    const fingerprint = generateFingerprint(updatedField.label, updatedField.type);

    try {
      await upsertAnswer({
        applywizz_id: targetApplywizzId,
        question_fingerprint: fingerprint,
        question_label: updatedField.label,
        field_type: updatedField.type,
        value: trimmedValue,
        source: 'manual',
        confidence: 1.0,
      });
      console.log(
        `[Applications Router] ✍️ Saved manual edit to candidate_qa_bank: candidate=${targetApplywizzId}, field=${updatedField.label}`
      );
    } catch (qaErr: any) {
      console.warn(`[Applications Router] ⚠️ QA bank upsert warning: ${qaErr.message}`);
    }

    res.json(updatedField);
  } catch (err: any) {
    console.error('[Applications Router] ❌ Unexpected error:', err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

/**
 * PATCH /api/applications/:id/status
 * Updates application status (APPLYING, APPLIED, FAILED, CAPTCHA_REQUIRED, QUEUED, etc.)
 * and immediately persists to Supabase.
 */
applicationsRouter.patch('/:id/status', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');
  const {
    status,
    jobUrl,
    error_message,
    errorMessage,
    proof_web_url,
    proofWebUrl,
    proof_captured_at,
    proofCapturedAt,
    dry_run_screenshot_url,
    dryRunScreenshotUrl,
    screenshotUrl,
    proof_failed_url,
    proofFailedUrl,
    proof_failed_captured_at,
    proofFailedCapturedAt,
    proof_email_url,
    proofEmailUrl,
    proof_email_captured_at,
    proofEmailCapturedAt,
    proof_email_json,
    proofEmailJson,
    email_proof_status,
    emailProofStatus,
    email_proof_attempted_at,
    emailProofAttemptedAt,
  } = req.body;

  if (!status) {
    res.status(400).json({ error: 'Missing status in request body.' });
    return;
  }

  try {
    const targetJobUrl = jobUrl || (req.query.jobUrl as string) || (req.query.job_url as string);
    let application: any = await getApplication(appId, targetJobUrl);
    if (!application && isSupabaseConfigured()) {
      const supabase = getDbClient();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId);
      let query = supabase.from('candidate_applications').select('*');
      if (isUuid) {
        query = query.eq('id', appId);
      } else {
        const candidateId = appId.includes('_') ? appId.split('_')[0] : appId;
        query = query.eq('applywizz_id', candidateId);
        if (targetJobUrl) query = query.eq('job_url', targetJobUrl);
      }
      const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
      application = data;
    }

    const targetAppId = application?.id || appId;
    const finalJobUrl = targetJobUrl || application?.job_url || application?.jobUrl;
    const finalApplywizz = application?.applywizz_id || application?.applywizzId || (appId.includes('_') ? appId.split('_')[0] : appId);

    const resolvedErrorMessage = error_message !== undefined ? error_message : errorMessage;
    const resolvedProofWebUrl = proof_web_url !== undefined ? proof_web_url : proofWebUrl;
    const resolvedProofCapturedAt = proof_captured_at !== undefined ? proof_captured_at : proofCapturedAt;
    const resolvedDryRunUrl = dry_run_screenshot_url !== undefined ? dry_run_screenshot_url : (dryRunScreenshotUrl !== undefined ? dryRunScreenshotUrl : screenshotUrl);
    const resolvedProofFailedUrl = proof_failed_url !== undefined ? proof_failed_url : proofFailedUrl;
    const resolvedProofFailedCapturedAt = proof_failed_captured_at !== undefined ? proof_failed_captured_at : proofFailedCapturedAt;
    const resolvedProofEmailUrl = proof_email_url !== undefined ? proof_email_url : proofEmailUrl;
    const resolvedProofEmailCapturedAt = proof_email_captured_at !== undefined ? proof_email_captured_at : proofEmailCapturedAt;
    const resolvedProofEmailJson = proof_email_json !== undefined ? proof_email_json : proofEmailJson;
    const resolvedEmailProofStatus = email_proof_status !== undefined ? email_proof_status : emailProofStatus;
    const resolvedEmailProofAttemptedAt = email_proof_attempted_at !== undefined ? email_proof_attempted_at : emailProofAttemptedAt;

    let effectiveStatus = status as ApplicationStatus;
    if (status === 'APPLYING') {
      console.log(`[API] Submit endpoint received → setting status to: QUEUED (was: APPLYING)`);
      effectiveStatus = 'QUEUED';
    }
    console.log(`[API] Status → ${effectiveStatus} (PATCH /applications/${appId})`);

    const statusChanged = await updateStatus(targetAppId, effectiveStatus, {
      proof_web_url: resolvedProofWebUrl,
      proof_captured_at: resolvedProofCapturedAt,
      proof_failed_url: resolvedProofFailedUrl,
      proof_failed_captured_at: resolvedProofFailedCapturedAt,
      proof_email_url: resolvedProofEmailUrl,
      proof_email_json: resolvedProofEmailJson,
      proof_email_captured_at: resolvedProofEmailCapturedAt,
      email_proof_status: resolvedEmailProofStatus,
      email_proof_attempted_at: resolvedEmailProofAttemptedAt,
      dry_run_screenshot_url: resolvedDryRunUrl,
      error_message: resolvedErrorMessage,
      job_url: finalJobUrl,
    });

    if (finalApplywizz && finalJobUrl) {
      await upsertApplication({
        id: application?.id,
        applywizz_id: finalApplywizz,
        job_url: finalJobUrl,
        status: effectiveStatus,
        submission_order: application?.submission_order,
        assigned_ca_email: application?.assigned_ca_email,
        resolved_fields: application?.resolved_fields || application?.resolvedFields || [],
        proof_web_url: resolvedProofWebUrl || application?.proof_web_url || application?.proofWebUrl,
        proof_captured_at: resolvedProofCapturedAt || application?.proof_captured_at || application?.proofCapturedAt,
        proof_failed_url: resolvedProofFailedUrl || application?.proof_failed_url || application?.proofFailedUrl,
        proof_failed_captured_at: resolvedProofFailedCapturedAt || application?.proof_failed_captured_at || application?.proofFailedCapturedAt,
        proof_email_url: resolvedProofEmailUrl || application?.proof_email_url || application?.proofEmailUrl,
        proof_email_json: resolvedProofEmailJson || application?.proof_email_json || application?.proofEmailJson,
        proof_email_captured_at: resolvedProofEmailCapturedAt || application?.proof_email_captured_at || application?.proofEmailCapturedAt,
        email_proof_status: resolvedEmailProofStatus || application?.email_proof_status || application?.emailProofStatus,
        email_proof_attempted_at: resolvedEmailProofAttemptedAt || application?.email_proof_attempted_at || application?.emailProofAttemptedAt,
        dry_run_screenshot_url: resolvedDryRunUrl || application?.dry_run_screenshot_url || application?.dryRunScreenshotUrl,
        error_message: resolvedErrorMessage !== undefined ? resolvedErrorMessage : application?.error_message,
      });
    }

    // Emit WebSocket event on worker failure for instant UI notification
    if (status === 'FAILED' && statusChanged) {
      const failReason = resolvedErrorMessage || application?.error_message || 'Submission execution failed.';
      wsManager.emitApplicationFailed({
        appId: targetAppId,
        reason: failReason,
        timestamp: new Date().toISOString(),
        jobUrl: finalJobUrl,
        applywizzId: finalApplywizz,
        companyName: application?.company_name || application?.companyName,
        jobTitle: application?.job_title || application?.jobTitle,
        proofFailedUrl: resolvedProofFailedUrl || application?.proof_failed_url || application?.proofFailedUrl,
      });
    }

    // Fetch latest hydrated application record and return full serialized DTO
    let updatedApp: any = await getApplication(targetAppId, finalJobUrl);
    if (!updatedApp && application) {
      updatedApp = {
        ...application,
        status: effectiveStatus,
        error_message: resolvedErrorMessage !== undefined ? resolvedErrorMessage : application.error_message,
        proof_failed_url: resolvedProofFailedUrl || application.proof_failed_url,
        proof_failed_captured_at: resolvedProofFailedCapturedAt || application.proof_failed_captured_at,
        proof_web_url: resolvedProofWebUrl || application.proof_web_url,
        proof_captured_at: resolvedProofCapturedAt || application.proof_captured_at,
      };
    }

    if (updatedApp) {
      updatedApp = await hydrateApplicationProofUrls(updatedApp);
    }

    const companyName = updatedApp?.company_name || updatedApp?.companyName || application?.company_name || application?.companyName || null;
    const jobTitle = updatedApp?.job_title || updatedApp?.jobTitle || application?.job_title || application?.jobTitle || null;

    const serializedDto = updatedApp
      ? serializeApplicationDto(updatedApp, {
          applywizz_id: finalApplywizz,
          job_url: finalJobUrl,
          company_name: companyName,
          job_title: jobTitle,
          status,
        })
      : {
          success: true,
          status,
          applicationId: targetAppId,
          error_message: resolvedErrorMessage,
          errorMessage: resolvedErrorMessage,
        };

    res.json({
      success: true,
      applicationId: targetAppId,
      ...serializedDto,
    });
  } catch (err: any) {
    console.error(`[Applications Router] ❌ Failed to update status for ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/applications/:id/approve
 * Persists resolved_fields and marks reviewed_at in Supabase immediately.
 */
applicationsRouter.post('/:id/approve', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');
  const { resolved_fields, status, jobUrl, companyName, jobTitle } = req.body;

  try {
    const targetJobUrl = jobUrl || (req.query.jobUrl as string) || (req.query.job_url as string);
    let application: any = await getApplication(appId, targetJobUrl);
    if (!application && isSupabaseConfigured()) {
      const supabase = getDbClient();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId);
      let query = supabase.from('candidate_applications').select('*');
      if (isUuid) {
        query = query.eq('id', appId);
      } else {
        const candidateId = appId.includes('_') ? appId.split('_')[0] : appId;
        query = query.eq('applywizz_id', candidateId);
        if (targetJobUrl) query = query.eq('job_url', targetJobUrl);
      }
      const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
      application = data;
    }

    const finalJobUrl = targetJobUrl || application?.job_url || application?.jobUrl;
    const finalApplywizz = application?.applywizz_id || application?.applywizzId || (appId.includes('_') ? appId.split('_')[0] : appId);
    const fieldsToSave = resolved_fields || application?.resolved_fields || application?.resolvedFields || [];
    let newStatus = (status || application?.status || 'READY_FOR_REVIEW') as ApplicationStatus;
    if (newStatus === 'APPLYING') {
      console.log(`[API] Submit endpoint received → setting status to: QUEUED (was: APPLYING)`);
      newStatus = 'QUEUED';
    }

    if (!finalJobUrl) {
      res.status(400).json({ error: 'Cannot approve application without job URL.' });
      return;
    }

    const saved = await upsertApplication({
      id: application?.id,
      applywizz_id: finalApplywizz,
      job_url: finalJobUrl,
      company_name: companyName || application?.company_name || application?.companyName || null,
      job_title: jobTitle || application?.job_title || application?.jobTitle || null,
      status: newStatus,
      resolved_fields: fieldsToSave,
      has_manual_edits: true,
      reviewed_at: new Date().toISOString(),
    });

    if (saved?.id) {
      await updateResolvedFields(saved.id, fieldsToSave, {
        has_manual_edits: true,
        reviewed_at: new Date().toISOString(),
        job_url: finalJobUrl,
        applywizz_id: finalApplywizz,
      });
    }

    res.json({
      success: true,
      application: saved,
    });
  } catch (err: any) {
    console.error(`[Applications Router] ❌ Failed to approve application ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/applications/notifications
 * Retrieves recent succeeded (APPLIED) and failed (FAILED) applications with failure reasons.
 */
applicationsRouter.get('/notifications', async (_req: Request, res: Response): Promise<void> => {
  try {
    const notifications = await getRecentNotifications(40);
    res.json(notifications);
  } catch (err: any) {
    console.error('[Applications Router] Failed to get notifications:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch notifications' });
  }
});

/**
 * GET /api/applications
 * Returns applications filtered strictly by authenticated CA email and candidate they are viewing.
 */
applicationsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const user = (req as any).user;
  const userEmail = getAuthenticatedCaEmail(req as any);
  const isAdmin = isUserAdmin(user || userEmail);

  const rawCandidate = req.query.applywizzId || req.query.applywizz_id || req.query.candidateId;
  const applywizzId = (typeof rawCandidate === 'string' ? rawCandidate : '').trim();

  const targetDate =
    typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : getYesterdayIST();

  try {
    let allowedIds: Set<string> | null = null;
    if (!isAdmin) {
      if (!userEmail) {
        res.status(401).json({ error: 'Unauthorized: missing user email on session.' });
        return;
      }
      let cached = getCachedWorkHistory(userEmail, targetDate) || getCachedWorkHistory(userEmail);
      if (!cached) {
        const whResult = await fetchWorkHistoryForDate(userEmail, targetDate);
        setCachedWorkHistory(userEmail, whResult.records, whResult.candidateIds, whResult.unreachable, whResult.resolvedDate, targetDate);
        cached = {
          records: whResult.records,
          candidateIds: whResult.candidateIds,
          expiresAt: Date.now() + 5 * 60 * 1000,
          unreachable: whResult.unreachable,
          resolvedDate: whResult.resolvedDate,
        };
      }
      if (cached.candidateIds.length === 0 && !req.query.date) {
        const allowedResult = await fetchAllowedCandidates(userEmail);
        if (allowedResult.candidateIds.length > 0) {
          setCachedWorkHistory(userEmail, allowedResult.records, allowedResult.candidateIds, allowedResult.unreachable, allowedResult.resolvedDate);
          cached = {
            records: allowedResult.records,
            candidateIds: allowedResult.candidateIds,
            expiresAt: Date.now() + 5 * 60 * 1000,
            unreachable: allowedResult.unreachable,
            resolvedDate: allowedResult.resolvedDate,
          };
        }
      }
      allowedIds = new Set(cached.candidateIds.map((id) => id.toUpperCase()));

      if (applywizzId && !allowedIds.has(applywizzId.toUpperCase())) {
        console.warn(
          `[API] GET /api/applications (ca_email=${userEmail}) → 403 (candidate ${applywizzId} not assigned to CA on ${targetDate})`
        );
        res.status(403).json({
          error: `Access denied: Candidate '${applywizzId}' is not assigned to your account.`,
          applications: [],
        });
        return;
      }
    }

    let applications: any[] = [];
    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      let query = supabase.from('candidate_applications').select('*');
      if (applywizzId) {
        query = query.eq('applywizz_id', applywizzId);
      } else if (allowedIds) {
        query = query.in('applywizz_id', Array.from(allowedIds));
      }
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
      applications = (data || []).filter((app: any) => {
        if (!isAdmin && userEmail && app.assigned_ca_email) {
          return app.assigned_ca_email.trim().toLowerCase() === userEmail.trim().toLowerCase();
        }
        return true;
      });
    }

    const logCandidate = applywizzId ? ` candidate=${applywizzId}` : '';
    console.log(
      `[API] GET /api/applications (ca_email=${userEmail || 'admin'}${logCandidate}) → filtered to ${applications.length} applications`
    );
    res.json({ applications });
  } catch (err: any) {
    console.error('[Applications Router] Failed to fetch applications:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/applications/:id
 * Retrieves an application record with complete status, fields, and proof URLs.
 * Hydrates directly from Supabase first.
 */
applicationsRouter.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');
  const jobUrl = (typeof req.query.job_url === 'string' ? req.query.job_url : '') ||
                 (typeof req.query.jobUrl === 'string' ? req.query.jobUrl : '');

  try {
    let app: any = null;

    if (isSupabaseConfigured()) {
      const supabase = getDbClient();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId);
      let query = supabase.from('candidate_applications').select('*');
      if (isUuid) {
        query = query.eq('id', appId);
      } else {
        const candidateId = appId.includes('_') ? appId.split('_')[0] : appId;
        query = query.eq('applywizz_id', candidateId);
        if (jobUrl) query = query.eq('job_url', jobUrl);
      }
      const { data } = await query
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      app = data;
    }

    if (!app) {
      app = await getApplication(appId, jobUrl);
    }

    if (!app) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }

    app = await hydrateApplicationProofUrls(app);

    const companyName = app.company_name || app.companyName || null;
    const jobTitle = app.job_title || app.jobTitle || null;
    const targetJobUrl = app.job_url || app.jobUrl || null;
    const targetApplywizzId = app.applywizz_id || app.applywizzId;

    res.json(
      serializeApplicationDto(app, {
        applywizz_id: targetApplywizzId,
        job_url: targetJobUrl,
        company_name: companyName,
        job_title: jobTitle,
      })
    );
  } catch (err: any) {
    console.error(`[Applications Router] ❌ Error fetching application ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default applicationsRouter;
