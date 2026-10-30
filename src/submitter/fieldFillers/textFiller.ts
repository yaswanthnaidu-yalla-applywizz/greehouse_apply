/**
 * @fileoverview Strategy for text, textarea, phone, and location autocomplete input fields.
 */

import type { Page } from 'playwright';
import type { ResolvedField } from '../../types/index.js';
import type { FormFillerOptions, FieldFillResult } from '../formFiller.js';
import {
  findElementLocator,
  escapeAttr,
  escapeId,
  dispatchReactInputEvents,
} from './base.js';
import { sanitizePhoneNumberForSubmission } from '../formFiller.js';

export async function fillTextField(
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

  if (fieldId === 'phone' || name === 'phone' || /phone/i.test(label)) {
    val = sanitizePhoneNumberForSubmission(val, options.phoneCountryCode || '+1');
  }

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
      fillResult.error = 'Required field has no value';
      fillResult.skippedRequired = true;
    } else {
      fillResult.success = true;
    }
    return fillResult;
  }

  if (rawType === 'textarea') {
    const textareaSelectors = [
      (field as any).metadata?.selector,
      `textarea#${escapeId(name)}`,
      `textarea#${escapeId(fieldId)}`,
      `#${escapeId(name)}`,
      `#${escapeId(fieldId)}`,
      `textarea[name="${escapeAttr(name)}"]`,
      `textarea[name="${escapeAttr(fieldId)}"]`,
      `textarea[id*="${escapeAttr(fieldId)}"]`,
      `textarea[id*="${escapeAttr(name)}"]`,
    ].filter(Boolean) as string[];

    const found = await findElementLocator(page, textareaSelectors, timeoutMs);
    if (found) {
      await found.locator.scrollIntoViewIfNeeded().catch(() => {});
      await found.locator.click().catch(() => {});
      await found.locator.fill(val, { timeout: timeoutMs });
      await dispatchReactInputEvents(found.locator);
      fillResult.success = true;
    } else {
      const labelLoc = page.locator(`label:has-text("${label}")`).first();
      if ((await labelLoc.count()) > 0) {
        const targetTextarea = labelLoc.locator('..').locator('textarea').first();
        if ((await targetTextarea.count()) > 0) {
          await targetTextarea.scrollIntoViewIfNeeded().catch(() => {});
          await targetTextarea.click().catch(() => {});
          await targetTextarea.fill(val, { timeout: timeoutMs });
          await dispatchReactInputEvents(targetTextarea);
          fillResult.success = true;
        } else {
          throw new Error(`Textarea not found under label for ${name} (${label})`);
        }
      } else {
        throw new Error(`Textarea not found for ${name} (${label})`);
      }
    }
    return fillResult;
  }

  if (rawType === 'location_autocomplete') {
    const locationSelectors = [
      (field as any).metadata?.selector,
      '#candidate-location',
      '#candidate_location',
      `#${escapeId(name)}`,
      `#${escapeId(fieldId)}`,
      `#${escapeId(name.replace(/_/g, '-'))}`,
      `#${escapeId(fieldId.replace(/_/g, '-'))}`,
      `#job_application_location`,
      `input[name="${escapeAttr(name)}"]`,
      `input[name*="location"]`,
      `#location`,
    ].filter(Boolean) as string[];

    const found = await findElementLocator(page, locationSelectors, timeoutMs);
    if (found) {
      await found.locator.scrollIntoViewIfNeeded().catch(() => {});
      await found.locator.click().catch(() => {});
      await found.locator.fill('');

      const searchPrefix = val.includes(',') ? val.split(',')[0].trim() : val;
      await found.locator.pressSequentially(searchPrefix, { delay: 40 });

      await page.waitForSelector(
        '.select__option, [id*="-option"], .location-autocomplete-options li, ul[role="listbox"] li, .pac-item, .autocomplete-result',
        { timeout: 4000 }
      ).catch(() => {});
      await page.waitForTimeout(400);

      let targetOption = page.locator('.select__option, [id*="-option"]').filter({ hasText: val }).first();
      if ((await targetOption.count()) === 0 && val.includes(',')) {
        const parts = val.split(',').map((p) => p.trim());
        if (parts.length > 1) {
          targetOption = page
            .locator('.select__option, [id*="-option"]')
            .filter({ hasText: new RegExp(parts[1].replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') })
            .first();
        }
      }
      if ((await targetOption.count()) === 0) {
        targetOption = page
          .locator('.select__option, [id*="-option"]')
          .filter({ hasText: new RegExp(searchPrefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i') })
          .first();
      }

      if ((await targetOption.count()) > 0) {
        await targetOption.click({ timeout: 2500 }).catch(() => {});
        fillResult.success = true;
      } else {
        await page.keyboard.press('ArrowDown').catch(() => {});
        await page.waitForTimeout(100);
        await page.keyboard.press('Enter').catch(() => {});
        await page.keyboard.press('Tab').catch(() => {});
        fillResult.success = true;
      }
    } else {
      throw new Error(`Location autocomplete input not found for ${name}`);
    }
    return fillResult;
  }

  // Standard Text Input
  const textSelectors: (string | undefined)[] = [
    (field as any).metadata?.selector,
  ];

  if (fieldId === 'first_name' || name === 'first_name' || /first\s*name|given\s*name/i.test(label)) {
    textSelectors.push(
      '#first_name',
      'input#first_name',
      'input[name="first_name"]',
      'input[name="job_application[first_name]"]',
      'input[autocomplete="given-name"]',
      'input[id*="first_name"]',
      'input[name*="first_name"]'
    );
  } else if (fieldId === 'last_name' || name === 'last_name' || /last\s*name|family\s*name/i.test(label)) {
    textSelectors.push(
      '#last_name',
      'input#last_name',
      'input[name="last_name"]',
      'input[name="job_application[last_name]"]',
      'input[autocomplete="family-name"]',
      'input[id*="last_name"]',
      'input[name*="last_name"]'
    );
  } else if (fieldId === 'email' || name === 'email' || /email/i.test(label)) {
    textSelectors.push(
      '#email',
      'input#email',
      'input[type="email"]',
      'input[name="email"]',
      'input[name="job_application[email]"]',
      'input[autocomplete="email"]',
      'input[id*="email"]',
      'input[name*="email"]'
    );
  } else if (fieldId === 'phone' || name === 'phone' || /phone/i.test(label)) {
    textSelectors.push(
      '#phone',
      'input#phone',
      'input[type="tel"]',
      'input[name="phone"]',
      'input[name="job_application[phone]"]',
      'input[autocomplete="tel"]',
      'input[id*="phone"]',
      'input[name*="phone"]'
    );
  }

  textSelectors.push(
    `input#${escapeId(name)}`,
    `input#${escapeId(fieldId)}`,
    `#${escapeId(name)}`,
    `#${escapeId(fieldId)}`,
    `input[name="${escapeAttr(name)}"]`,
    `input[name="${escapeAttr(fieldId)}"]`,
    `input[id*="${escapeAttr(fieldId)}"]`,
    `input[id*="${escapeAttr(name)}"]`,
    `input[name*="${escapeAttr(fieldId)}"]`,
    `input[name*="${escapeAttr(name)}"]`
  );

  const found = await findElementLocator(page, textSelectors.filter(Boolean) as string[], timeoutMs);
  if (found) {
    await found.locator.scrollIntoViewIfNeeded().catch(() => {});
    await found.locator.click().catch(() => {});
    await found.locator.fill(val, { timeout: timeoutMs });
    await dispatchReactInputEvents(found.locator);
    fillResult.success = true;
  } else {
    const labelLoc = page.locator(`label:has-text("${label}")`).first();
    if ((await labelLoc.count()) > 0) {
      const input = labelLoc.locator('..').locator('input:not([type="hidden"]), textarea').first();
      if ((await input.count()) > 0) {
        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click().catch(() => {});
        await input.fill(val, { timeout: timeoutMs });
        await dispatchReactInputEvents(input);
        fillResult.success = true;
      } else {
        throw new Error(`Input not found under label for ${name} (${label})`);
      }
    } else {
      throw new Error(`Input not found for ${name} (${label})`);
    }
  }

  return fillResult;
}
