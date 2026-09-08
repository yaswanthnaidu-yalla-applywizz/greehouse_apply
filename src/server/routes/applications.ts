/**
 * @fileoverview Express Router for Candidate Applications and Field Modifications (V2).
 *
 * Endpoints:
 * - PATCH /api/applications/:id/fields/:fieldId: Modifies field value, updates DB, and saves to candidate_qa_bank (source: 'manual').
 * - GET /api/applications/:id: Retrieves single application record.
 */

import { Router, Request, Response } from 'express';
import { getApplication } from '../../db/applications.js';
import { upsertAnswer } from '../../db/qaBank.js';
import { getDbClient } from '../../db/client.js';
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
    const supabase = getDbClient();

    // 1. Fetch application from Supabase
    // Try UUID first; if not found or not UUID, try matching by applywizz_id
    let application: any = null;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId);

    if (isUuid) {
      application = await getApplication(appId);
    }

    if (!application) {
      // Try searching candidate_applications by applywizz_id or composite id
      const { data } = await supabase
        .from('candidate_applications')
        .select('*')
        .or(`id.eq.${appId},applywizz_id.eq.${appId}`)
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

    // 3. Persist updated resolved_fields to Supabase candidate_applications
    const { error: updateError } = await supabase
      .from('candidate_applications')
      .update({
        resolved_fields: resolvedFields,
        updated_at: new Date().toISOString(),
      })
      .eq('id', application.id);

    if (updateError) {
      console.error(`[Applications Router] ❌ DB update failed: ${updateError.message}`);
      res.status(500).json({ error: `Database update failed: ${updateError.message}` });
      return;
    }

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
 * Retrieves an application record.
 */
applicationsRouter.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const rawAppId = req.params.id;
  const appId = Array.isArray(rawAppId) ? rawAppId[0] : String(rawAppId || '');

  try {
    const app = await getApplication(appId);
    if (!app) {
      res.status(404).json({ error: `Application '${appId}' not found.` });
      return;
    }
    res.json(app);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default applicationsRouter;
