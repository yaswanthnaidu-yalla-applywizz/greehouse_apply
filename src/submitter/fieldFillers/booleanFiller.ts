/**
 * @fileoverview Strategy for boolean, radio, and checkbox input fields.
 */

import type { Page } from 'playwright';
import type { ResolvedField } from '../../types/index.js';
import type { FormFillerOptions, FieldFillResult } from '../formFiller.js';
import {
  findElementLocator,
  clickBooleanOption,
  escapeAttr,
  escapeId,
} from './base.js';

function normalizeBooleanValue(val: string): 'Yes' | 'No' | null {
  const lower = val.trim().toLowerCase();
  if (['true', 'yes', '1', 'y'].includes(lower)) return 'Yes';
  if (['false', 'no', '0', 'n'].includes(lower)) return 'No';
  return null;
}

export async function fillBooleanField(
  page: Page,
  field: ResolvedField,
  options: FormFillerOptions = {}
): Promise<FieldFillResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  let val = (field.value ?? '').trim();
  const rawType = (field.type || 'text').toLowerCase();
  const name = field.name || field.fieldId || '';
  const fieldId = field.fieldId || field.name || '';
  const label = field.label || name;
  const booleanValue = normalizeBooleanValue(val);

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

  if (rawType === 'radio') {
    const radioTargets = [booleanValue, val].filter(Boolean) as string[];
    let checked = false;

    for (const target of radioTargets) {
      const radioSelectors = [
        `input[type="radio"][name="${escapeAttr(name)}"][value="${escapeAttr(target)}"]`,
        `input[type="radio"][name="${escapeAttr(fieldId)}"][value="${escapeAttr(target)}"]`,
        `input[type="radio"][value="${escapeAttr(target)}"]`,
      ];
      for (const sel of radioSelectors) {
        const found = await findElementLocator(page, [sel], timeoutMs);
        if (found) {
          if (booleanValue) {
            await clickBooleanOption(found.locator, fieldId, sel, booleanValue);
          } else {
            await found.locator.scrollIntoViewIfNeeded().catch(() => {});
            await found.locator.check({ force: true });
          }
          checked = true;
          break;
        }
      }
      if (checked) break;

      const radios = page.locator(`input[type="radio"][name="${escapeAttr(name)}"], input[type="radio"][name="${escapeAttr(fieldId)}"]`);
      const count = await radios.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const radio = radios.nth(i);
        const radioVal = await radio.getAttribute('value').catch(() => null);
        const radioId = await radio.getAttribute('id').catch(() => null);

        let labelText = '';
        if (radioId) {
          const labelFor = page.locator(`label[for="${escapeId(radioId)}"]`).first();
          if ((await labelFor.count()) > 0) {
            labelText = (await labelFor.innerText()) || '';
          }
        }
        if (!labelText) {
          const parentLabel = radio.locator('..').first();
          if ((await parentLabel.count()) > 0) {
            labelText = (await parentLabel.innerText()) || '';
          }
        }

        const cleanLabel = labelText.trim().toLowerCase();
        const cleanTarget = target.toLowerCase().trim();

        if (cleanLabel === cleanTarget || (radioVal && radioVal.toLowerCase() === cleanTarget)) {
          const optionSelector =
            radioVal && booleanValue && radioVal.toLowerCase() === booleanValue.toLowerCase()
              ? `input[type="radio"][value="${booleanValue}"]`
              : `input[type="radio"][name="${escapeAttr(name)}"]`;
          if (booleanValue) {
            await clickBooleanOption(radio, fieldId, optionSelector, booleanValue);
          } else {
            await radio.scrollIntoViewIfNeeded().catch(() => {});
            await radio.check({ force: true });
          }
          checked = true;
          break;
        }
      }
      if (checked) break;
    }

    if (!checked) {
      const labelLoc = page.locator('label').filter({ hasText: val }).first();
      if ((await labelLoc.count()) > 0) {
        if (booleanValue) {
          await clickBooleanOption(labelLoc, fieldId, `label:has-text("${booleanValue}")`, booleanValue);
        } else {
          await labelLoc.click({ force: true });
        }
        checked = true;
      }
    }

    if (checked) {
      fillResult.success = true;
    } else {
      throw new Error(`Radio option "${val}" not matched for group ${name}`);
    }
    return fillResult;
  }

  // Checkbox or boolean switch
  const isAffirmative = booleanValue === 'Yes' || ['true', '1'].includes(val.toLowerCase());
  if (isAffirmative) {
    const checkboxSelectors = [
      (field as any).metadata?.selector,
      `input[type="checkbox"][name="${escapeAttr(name)}"]`,
      `input[type="checkbox"][name="${escapeAttr(fieldId)}"]`,
      `input[type="checkbox"]#${escapeId(name)}`,
      `input[type="checkbox"]#${escapeId(fieldId)}`,
      `#${escapeId(name)}`,
      `#${escapeId(fieldId)}`,
    ].filter(Boolean);

    const found = await findElementLocator(page, checkboxSelectors, timeoutMs);
    if (found) {
      const checkboxSelector = found.selector || checkboxSelectors[0];
      await found.locator.scrollIntoViewIfNeeded().catch(() => {});
      await found.locator.check({ force: true, timeout: 3000 }).catch(async () => {
        await clickBooleanOption(found.locator, fieldId, checkboxSelector, 'Yes');
      });
      fillResult.success = true;
    } else {
      const labelLoc = page.locator(`label:has-text("${label}")`).first();
      if ((await labelLoc.count()) > 0) {
        const cb = labelLoc.locator('..').locator('input[type="checkbox"]').first();
        if ((await cb.count()) > 0) {
          await cb.check({ force: true });
          fillResult.success = true;
        }
      }
    }
  } else {
    fillResult.success = true;
  }

  return fillResult;
}
