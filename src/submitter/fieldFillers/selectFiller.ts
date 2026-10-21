/**
 * @fileoverview Strategy for native select and React-Select / custom combobox dropdowns.
 */

import type { Page } from 'playwright';
import type { ResolvedField } from '../../types/index.js';
import type { FormFillerOptions, FieldFillResult } from '../formFiller.js';
import {
  findElementLocator,
  escapeAttr,
  escapeId,
  sleepRandomJitter,
} from './base.js';
import { matchChoiceOption } from '../../utils/choiceOptions.js';

export async function fillSelectField(
  page: Page,
  field: ResolvedField,
  _applywizzId: string,
  options: FormFillerOptions = {}
): Promise<FieldFillResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  let val = (field.value ?? '').trim();
  const rawType = (field.type || 'select').toLowerCase();
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

  if (!val) {
    if (field.isRequired === true) {
      fillResult.success = false;
      fillResult.error = 'Required select field has no value';
      fillResult.skippedRequired = true;
    } else {
      fillResult.success = true;
    }
    return fillResult;
  }

  const selectSelectors = [
    (field as any).metadata?.selector,
    `select#${escapeId(name)}`,
    `select#${escapeId(fieldId)}`,
    `select[name="${escapeAttr(name)}"]`,
    `select[name="${escapeAttr(fieldId)}"]`,
    `#${escapeId(name)}`,
    `#${escapeId(fieldId)}`,
    `[name="${escapeAttr(name)}"]`,
    `[name="${escapeAttr(fieldId)}"]`,
  ].filter(Boolean) as string[];

  let found = await findElementLocator(page, selectSelectors, timeoutMs);
  if (!found) {
    const labelLoc = page.locator(`label:has-text("${label}")`).first();
    if ((await labelLoc.count()) > 0) {
      const candidate = labelLoc.locator('..').locator('select, input, [role="combobox"]').first();
      if ((await candidate.count()) > 0) {
        found = { locator: candidate, selector: `label("${label}") -> select` };
      }
    }
  }

  if (!found) {
    throw new Error(`Select element not found for ${name} (${label})`);
  }

  const tagName = await found.locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'SELECT');

  if (tagName === 'SELECT') {
    const nativeOptions = await found.locator.locator('option').allInnerTexts().catch(() => []);
    const matchedOption = matchChoiceOption(val, nativeOptions);
    if (matchedOption) {
      await found.locator.scrollIntoViewIfNeeded().catch(() => {});
      await found.locator.selectOption({ label: matchedOption }, { timeout: timeoutMs }).catch(async () => {
        await found.locator.selectOption({ value: matchedOption }, { timeout: timeoutMs });
      });
      fillResult.valuePopulated = matchedOption;
      fillResult.success = true;
      return fillResult;
    }

    // Try selecting by value directly if options didn't match
    try {
      await found.locator.selectOption({ label: val }, { timeout: timeoutMs });
      fillResult.success = true;
      return fillResult;
    } catch {
      try {
        await found.locator.selectOption({ value: val }, { timeout: timeoutMs });
        fillResult.success = true;
        return fillResult;
      } catch (err: any) {
        throw new Error(`Could not select option "${val}" in native select: ${err.message}`);
      }
    }
  }

  // React-Select / Combobox / Custom Dropdown
  await found.locator.scrollIntoViewIfNeeded().catch(() => {});
  await found.locator.click().catch(() => {});
  await sleepRandomJitter(150, 300);

  // If it is an input, type to filter options
  if (tagName === 'INPUT') {
    await found.locator.fill(val).catch(() => {});
    await page.waitForTimeout(200);
  }

  const optionLoc = page.locator('.select__option, [id*="-option"], [role="option"]').filter({ hasText: val }).first();
  if ((await optionLoc.count()) > 0) {
    await optionLoc.click({ timeout: 2500 });
    fillResult.success = true;
  } else {
    // Commit via keyboard navigation
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter').catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
    fillResult.success = true;
  }

  return fillResult;
}
