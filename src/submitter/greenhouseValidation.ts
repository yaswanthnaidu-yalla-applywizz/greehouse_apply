import type { Page } from 'playwright';
import type { ApplicationRow } from '../db/applications.js';
import type { FormFillSummary } from './formFiller.js';

export interface GreenhouseValidationFailure {
  kind: 'FIELD_VALIDATION';
  fields: Array<{ fieldId: string; label: string; message: string }>;
}

export interface GreenhouseSubmissionGateSuccess {
  ok: true;
  committedRequiredFieldIds: string[];
}

export interface GreenhouseSubmissionGateFailure {
  ok: false;
  failure: GreenhouseValidationFailure;
}

export type GreenhouseSubmissionGateResult =
  | GreenhouseSubmissionGateSuccess
  | GreenhouseSubmissionGateFailure;

function isRequired(result: FormFillSummary['results'][number]): boolean {
  return result.isRequired === true;
}

export async function validateGreenhouseSubmission(
  page: Page,
  _application: ApplicationRow,
  fillSummary: FormFillSummary,
): Promise<GreenhouseSubmissionGateResult> {
  const missing = fillSummary.results
    .filter((result) => isRequired(result) && (!result.success || result.domCommitted === false || !result.valuePopulated.trim()))
    .map((result) => ({
      fieldId: result.fieldId,
      label: result.label,
      message: result.error || 'Required field was not committed to the DOM',
    }));

  const invalidFields = await page.evaluate(() => {
    const invalid = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid'));
    return invalid.map((element) => {
      const input = element as HTMLInputElement;
      const label = input.id
        ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent
        : input.getAttribute('aria-label') || input.getAttribute('name');
      return {
        fieldId: input.id || input.getAttribute('name') || 'unknown',
        label: (label || 'unknown').trim(),
        message: input.validationMessage || 'Browser validation rejected the field',
      };
    });
  }).catch(() => []);

  const fields = [...missing];
  for (const invalid of invalidFields) {
    if (!fields.some((field) => field.fieldId === invalid.fieldId)) fields.push(invalid);
  }
  if (fields.length > 0) return { ok: false, failure: { kind: 'FIELD_VALIDATION', fields } };
  return {
    ok: true,
    committedRequiredFieldIds: fillSummary.results.filter(isRequired).map((result) => result.fieldId),
  };
}
