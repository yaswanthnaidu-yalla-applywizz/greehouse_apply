/**
 * @fileoverview File upload strategy (Master Resume PDF ONLY).
 */

import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import type { ResolvedField } from '../../types/index.js';
import type { FormFillerOptions, FieldFillResult } from '../formFiller.js';
import { downloadResumeTempFile, isDemoResumeApplywizzId } from '../../db/storage.js';
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

  const isResume = fieldId === 'resume' || name.toLowerCase().includes('resume') || /resume|cv\b/i.test(label);
  if (!isResume || /cover/i.test(`${name} ${fieldId} ${label}`)) {
    log.info(`[Form Filler] ⏭️ Skipping non-resume / cover letter file upload ("${label}").`);
    fillResult.success = true;
    fillResult.valuePopulated = '';
    return fillResult;
  }

  const fileSelectors = getResumeFileSelectors(
    (field as any).metadata?.selector,
    name,
    fieldId
  );

  const found = await findElementLocator(page, fileSelectors, timeoutMs);
  if (!found) {
    throw new Error(`File input element not found for resume upload (tried ${fileSelectors.join(', ')})`);
  }

  let tempResumePath = '';
  if (val && fs.existsSync(val)) {
    tempResumePath = val;
  } else {
    try {
      tempResumePath = await downloadResumeTempFile(applywizzId);
      if (resumeFilename) {
        const renamedResumePath = path.join(path.dirname(tempResumePath), resumeFilename);
        fs.renameSync(tempResumePath, renamedResumePath);
        tempResumePath = renamedResumePath;
      }
      tempFilesToClean.push(tempResumePath);
    } catch (dlErr: any) {
      if (isDemoResumeApplywizzId(applywizzId)) {
        const localCandidates = [
          path.resolve(process.cwd(), 'resumes', `${applywizzId}_resume.pdf`),
          path.resolve(process.cwd(), 'resumes', 'AWL-YASHANTH_resume.pdf'),
          path.resolve(process.cwd(), 'resumes', 'my-resume.pdf'),
        ];
        const foundLocal = localCandidates.find((p) => fs.existsSync(p));
        if (foundLocal) {
          tempResumePath = foundLocal;
        } else {
          throw new Error(`Could not obtain resume PDF: ${dlErr.message}`);
        }
      } else {
        throw new Error(`Could not obtain resume PDF: ${dlErr.message}`);
      }
    }
  }

  await found.locator.setInputFiles(tempResumePath, { timeout: timeoutMs });
  const attachedCount = await found.locator
    .evaluate((el: HTMLInputElement) => (el.files ? el.files.length : 1))
    .catch(() => 1);
  if (attachedCount === 0) {
    throw new Error('RESUME_UPLOAD_FAILED: no files attached to resume input');
  }
  fillResult.valuePopulated = tempResumePath;
  fillResult.success = true;
  log.info(`[Form Filler] ✅ Uploaded resume for ${applywizzId}`);
  return fillResult;
}
