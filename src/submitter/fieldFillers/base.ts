/**
 * @fileoverview Base DOM helpers, event dispatchers, and types for field filler strategies.
 */

import type { Page, Locator } from 'playwright';
import type { ResolvedField } from '../../types/index.js';
import type { FormFillerOptions } from '../formFiller.js';
import { createLogger } from '../../utils/logger.js';

export const log = createLogger('FieldFiller');

export interface FieldFillerContext {
  page: Page;
  field: ResolvedField;
  applywizzId: string;
  tempFilesToClean: string[];
  options: FormFillerOptions;
  resumeFilename?: string;
  val: string;
  rawType: string;
  name: string;
  fieldId: string;
  label: string;
  timeoutMs: number;
}

export function sleepRandomJitter(minMs: number = 300, maxMs: number = 800): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export function escapeId(str: string): string {
  if (!str) return '';
  return str.replace(/([\[\]#.:(),"'\\/])/g, '\\$1');
}

export function escapeAttr(str: string): string {
  if (!str) return '';
  return str.replace(/["\\]/g, '\\$&');
}

export async function findElementLocator(
  page: Page,
  selectors: string[],
  _timeoutMs?: number
): Promise<{ locator: Locator; selector: string } | null> {
  for (const selector of selectors) {
    if (!selector) continue;
    try {
      const loc = page.locator(selector).first();
      const count = await loc.count();
      if (count > 0) {
        return { locator: loc, selector };
      }
    } catch {
      // Continue to next fallback selector candidate
    }
  }
  return null;
}

export const CUSTOM_SELECT_OPTION_LOCATOR =
  '.select__option:not(.iti__country), [id*="-option"]:not(.iti__country), [role="option"]:not(.iti__country), .select2-results__option:not(.iti__country), [role="listbox"] [role="option"]:not(.iti__country), [class*="menu"] [role="option"]:not(.iti__country)';

export const GREENHOUSE_SELECT_INPUT_CONTAINER =
  '[class*="select_input-container"], .select_input-container, [class*="remix-css-"][class*="-container"]';

export function normalizeOptionText(text: string): string {
  return (text || '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function clickBooleanOption(
  locator: Locator,
  fieldName: string,
  selector: string,
  value: 'Yes' | 'No'
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
      await locator.click({ force: true, timeout: 3000 });
      log.info(
        `[Submitter] Boolean field "${fieldName}" → selector: ${selector} → clicked ✅ (${value})`
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) await locator.scrollIntoViewIfNeeded().catch(() => {});
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not click boolean option ${selector}`);
}

export async function dispatchReactInputEvents(locator: Locator): Promise<void> {
  await locator.evaluate((el: HTMLElement) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }).catch(() => {});
}
