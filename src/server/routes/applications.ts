/**
 * @fileoverview Express Router for Candidate Applications and Field Modifications (V2).
 *
 * Endpoints:
 * - PATCH /api/applications/:id/fields/:fieldId: Modifies field value, updates DB, and saves to candidate_qa_bank (source: 'manual').
 * - GET /api/applications/:id: Retrieves single application record.
 */

import { Router, Request, Response } from 'express';
import { getApplication, updateResolvedFields } from '../../db/applications.js';
import { upsertAnswer } from '../../db/qaBank.js';
import { getDbClient, isSupabaseConfigured } from '../../db/client.js';
import { generateFingerprint } from '../../resolver/fingerprint.js';
import type { ResolvedField } from '../../types/index.js';

export const applicationsRouter = Router();

/**
 * PATCH /api/applications/:id/fields/:fieldId
 * Modifies an individual form field answer.
 *
 * Request Body:
 * { "value": "New manual answer" }
 *
 * Actions:
 * 1. Validates value
 * 2. Updates resolved_fields in candidate_applications in Supabase
 * 3. Writes to candidate_qa_bank with source: 'manual'
 * 4. Returns the updated ResolvedField
 */
applicationsRouter.patch('/:id/fields/:fieldId', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const rawFieldId = req.params.fieldId;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');
  const fieldId = Array.isArray(rawFieldId) ? rawFieldId[0] : String(rawFieldId || '');

  const { value } = req.body;

  if (typeof value !== 'string') {
    res.status(400).json({ error: 'Request body must contain a string "value".' });
    return;
  }

  const trimmedValue = value.trim();

  try {
    // 1. Fetch application
    let application: any = await getApplication(appId);

    if (!application && isSupabaseConfigured()) {
      const supabase = getDbClient();
      const { data } = await supabase
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', appId)
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

    // 3. Persist updated resolved_fields and flag manual edit for queue prioritization
    await updateResolvedFields(application.id, resolvedFields, {
      has_manual_edits: true,
      reviewed_at: new Date().toISOString(),
    });

    // 4. Save to candidate_qa_bank with source: 'manual' for persistent memory
    const fingerprint = generateFingerprint(updatedField.label, updatedField.type);

    try {
      await upsertAnswer({
        applywizz_id: application.applywizz_id,
        question_fingerprint: fingerprint,
        question_label: updatedField.label,
        field_type: updatedField.type,
        value: trimmedValue,
        source: 'manual',
        confidence: 1.0,
      });
      console.log(
        `[Applications Router] ✍️ Saved manual edit to candidate_qa_bank: candidate=${application.applywizz_id}, field=${updatedField.label}`
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
 * GET /api/applications/:id
 * Retrieves an application record with complete status, fields, and proof URLs.
 */
applicationsRouter.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');

  try {
    let app: any = await getApplication(appId);

    if (!app && isSupabaseConfigured()) {
      const supabase = getDbClient();
      const { data } = await supabase
        .from('candidate_applications')
        .select('*')
        .eq('applywizz_id', appId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      app = data;
    }

    if (!app) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }

    res.json({
      id: app.id,
      applywizz_id: app.applywizz_id,
      job_url: app.job_url,
      company_name: app.company_name,
      job_title: app.job_title,
      status: app.status,
      resolved_fields: app.resolved_fields || [],
      proof_web_url: app.proof_web_url || null,
      proof_captured_at: app.proof_captured_at || null,
      dry_run_screenshot_url: app.dry_run_screenshot_url || null,
      error_message: app.error_message || null,
      submitted_at: app.submitted_at || null,
      created_at: app.created_at,
      updated_at: app.updated_at,
    });
  } catch (err: any) {
    console.error(`[Applications Router] ❌ Error fetching application ${appId}:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default applicationsRouter;
