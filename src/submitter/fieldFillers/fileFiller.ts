/**
 * @fileoverview File upload strategy (Master Resume PDF ONLY).
 */

import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import type { ResolvedField } from '../../types/index.js';
import type { FormFillerOptions, FieldFillResult } from '../formFiller.js';
import {
  downloadResumeTempFile,
  isDemoResumeApplywizzId,
  downloadOperatorFieldFile,
} from '../../db/storage.js';
import os from 'os';
import { findElementLocator, log } from './base.js';
import { getResumeFileSelectors } from '../formFiller.js';

export async function fillFileField(
  page: Page,
  field: ResolvedField,
  applywizzId: string,
  tempFilesToClean: string[],
  options: FormFillerOptions = {},
  resumeFilename?: string
): Promise<FieldFillResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  let val = (field.value ?? '').trim();
  const rawType = (field.type || 'text').toLowerCase();
  const name = field.name || field.fieldId || '';
  const fieldId = field.fieldId || field.name || '';
  const label = field.label || name;

  const fillResult: FieldFillResult = {
    fieldId,
    name,
    type: rawType,
    label,
    valuePopulated: val,
    isRequired: field.isRequired,
    source: field.source,
    success: false,
  };

  const isOperatorUploaded = Boolean(
    (field as any).metadata?.isOperatorUploaded ||
      val.includes('operator_uploads') ||
      val.startsWith('resumes/operator_uploads')
  );

  const isResume = fieldId === 'resume' || name.toLowerCase().includes('resume') || /resume|cv\b/i.test(label);

  // If this is neither a resume nor has an operator-provided file, skip unrequired file upload
  if (!isResume && !val && !isOperatorUploaded) {
    log.info(`[Form Filler] ⏭️ Skipping unpopulated non-resume file upload ("${label}").`);
    fillResult.success = true;
    fillResult.valuePopulated = '';
    return fillResult;
  }

  const fileSelectors = isResume
    ? getResumeFileSelectors((field as any).metadata?.selector, name, fieldId)
    : [
        (field as any).metadata?.selector,
        `input[type="file"][data-field*="${name}" i]`,
        `input[type="file"][name*="${name}" i]`,
        `input[type="file"][id*="${name}" i]`,
        `input[type="file"][data-field*="${fieldId}" i]`,
        `input[type="file"][name*="${fieldId}" i]`,
        `input[type="file"][id*="${fieldId}" i]`,
        'input[type="file"]',
      ].filter(Boolean) as string[];

  const found = await findElementLocator(page, fileSelectors, timeoutMs);
  if (!found) {
    throw new Error(`File input element not found for ${isResume ? 'resume' : label} upload (tried ${fileSelectors.join(', ')})`);
  }

  let tempUploadPath = '';
  if (val && fs.existsSync(val)) {
    tempUploadPath = val;
  } else if (isOperatorUploaded || val.includes('operator_uploads') || (field as any).metadata?.storagePath) {
    const storagePath = (field as any).metadata?.storagePath || val;
    try {
      const buffer = await downloadOperatorFieldFile(storagePath);
      const safeFilename =
        (field as any).metadata?.filename || path.basename(storagePath) || 'operator_upload.pdf';
      tempUploadPath = path.join(
        os.tmpdir(),
        `applywizz-op-${applywizzId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${safeFilename}`
      );
      await fs.promises.writeFile(tempUploadPath, buffer);
      tempFilesToClean.push(tempUploadPath);
    } catch (opErr: any) {
      log.warn(`[Form Filler] Failed to fetch operator uploaded file (${storagePath}): ${opErr.message}`);
      throw opErr;
    }
  } else if (isResume) {
    try {
      tempUploadPath = await downloadResumeTempFile(applywizzId);
      if (resumeFilename) {
        const renamedResumePath = path.join(path.dirname(tempUploadPath), resumeFilename);
        fs.renameSync(tempUploadPath, renamedResumePath);
        tempUploadPath = renamedResumePath;
      }
      tempFilesToClean.push(tempUploadPath);
    } catch (dlErr: any) {
      if (isDemoResumeApplywizzId(applywizzId)) {
        const localCandidates = [
          path.resolve(process.cwd(), 'resumes', `${applywizzId}_resume.pdf`),
          path.resolve(process.cwd(), 'resumes', 'AWL-YASHANTH_resume.pdf'),
          path.resolve(process.cwd(), 'resumes', 'my-resume.pdf'),
        ];
        const foundLocal = localCandidates.find((p) => fs.existsSync(p));
        if (foundLocal) {
          tempUploadPath = foundLocal;
        } else {
          throw new Error(`Could not obtain resume PDF: ${dlErr.message}`);
        }
      } else {
        throw new Error(`Could not obtain resume PDF: ${dlErr.message}`);
      }
    }
  } else {
    throw new Error(`No file found on disk or storage for field ${label} (${fieldId})`);
  }

  await found.locator.setInputFiles(tempUploadPath, { timeout: timeoutMs });
  const attachedCount = await found.locator
    .evaluate((el: HTMLInputElement) => (el.files ? el.files.length : 1))
    .catch(() => 1);
  if (attachedCount === 0) {
    throw new Error(`FILE_UPLOAD_FAILED: no files attached to ${isResume ? 'resume' : label} input`);
  }
  fillResult.valuePopulated = tempUploadPath;
  fillResult.success = true;
  log.info(`[Form Filler] ✅ Uploaded ${isResume ? 'resume' : label} for ${applywizzId}`);
  return fillResult;
}
