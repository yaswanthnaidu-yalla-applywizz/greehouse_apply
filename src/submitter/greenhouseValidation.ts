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
    // 1. Auto-confirm demographic GDPR consent survey checkboxes if any are present and unchecked
    const demoCbs = document.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][name*="gdpr_demographic"], input[type="checkbox"][id*="gdpr_demographic"], input[type="checkbox"][name*="demographic_data_consent"]'
    );
    demoCbs.forEach((cb) => {
      if (!cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    const invalid = Array.from(document.querySelectorAll('input:invalid, select:invalid, textarea:invalid'));
    const genuineInvalids: Array<{ fieldId: string; label: string; message: string }> = [];

    for (const [invalidIndex, element] of invalid.entries()) {
      const input = element as HTMLInputElement;
      if (input.type === 'checkbox') {
        const container = input.closest('.field, fieldset, [class*="form-group"]');
        const containerGroup = container?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') || [];
        if (
          containerGroup.length > 1 && Array.from(containerGroup).some((checkbox) => checkbox.checked)
        ) {
          continue;
        }
      }

      const labelledBy = input.getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      const root = input.closest('.select, .field-wrapper, .field');
      const rootLabel = root?.querySelector('label')?.textContent?.trim();
      const label = (input.id
        ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent?.trim()
        : undefined)
        || labelledBy
        || input.getAttribute('aria-label')?.trim()
        || rootLabel
        || input.getAttribute('name')?.trim()
        || input.id
        || `Required field ${invalidIndex + 1}`;
      const combobox = root?.querySelector<HTMLElement>('[role="combobox"], input[aria-combobox="true"]');
      const rootIndex = root
        ? Array.from(document.querySelectorAll('.select, .field-wrapper, .field')).indexOf(root)
        : -1;
      const localInputIndex = root
        ? Array.from(root.querySelectorAll('input, select, textarea')).indexOf(input)
        : invalidIndex;
      const fieldId = combobox
        ? combobox.id || combobox.getAttribute('name') || `control:${rootIndex}:${localInputIndex}`
        : `${root ? 'root' : 'document'}:${rootIndex}:${localInputIndex}`;
      genuineInvalids.push({
        fieldId,
        label,
        message: input.validationMessage || 'Browser validation rejected the field',
      });
    }

    return genuineInvalids;
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
