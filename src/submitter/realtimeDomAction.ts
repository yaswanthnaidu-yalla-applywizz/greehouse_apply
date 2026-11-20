/**
 * @fileoverview Live Playwright DOM Inspector & Action Committer for Real-Time Remediation.
 *
 * Scrapes live rendered options and control types directly from browser DOM,
 * executes humanized commitment actions, and verifies DOM state retention.
 */

import type { Page, Locator } from 'playwright';
import { createLogger } from '../utils/logger.js';
import type { RemediationDecision } from './realtimeRemediator.js';

const log = createLogger('Realtime DOM Action');

export interface ScrapedDomField {
  found: boolean;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'combobox';
  options: string[];
  locatorSelector: string;
  containerSelector?: string;
}

export interface CommitResult {
  success: boolean;
  committedValue: string;
  error?: string;
}

/**
 * Normalizes label text for resilient substring or exact DOM matching.
 */
function cleanLabel(text: string): string {
  return text
    .replace(/\s*\*+\s*$/, '') // strip trailing asterisk
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/**
 * Scrapes a live field container, its control type, and any rendered choices from the DOM.
 */
export async function scrapeLiveFieldFromDom(
  page: Page,
  fieldLabel: string
): Promise<ScrapedDomField | null> {
  const targetLabel = cleanLabel(fieldLabel);
  if (!targetLabel) return null;

  try {
    let root: Locator | null = null;
    let containerSelector: string | undefined = undefined;

    const escapedRaw = fieldLabel.replace(/"/g, '\\"');
    const directPath = page.locator(`[data-field-path="${escapedRaw}"], [id="${escapedRaw}"], [name="${escapedRaw}"]`).first();
    if ((await directPath.count()) > 0) {
      root = directPath;
      containerSelector = `[data-field-path="${escapedRaw}"]`;
    } else {
      // 1. Try finding by label or legend element
      const labelLocators = [
        page.locator(`label:has-text("${targetLabel}")`).first(),
        page.locator(`legend:has-text("${targetLabel}")`).first(),
        page.locator(`div:has-text("${targetLabel}")`).last(),
      ];

      let foundLabelLoc: Locator | null = null;
      for (const loc of labelLocators) {
        if ((await loc.count()) > 0) {
          foundLabelLoc = loc;
          break;
        }
      }

      if (!foundLabelLoc) {
        log.warn(`[Realtime DOM] Could not locate DOM container for label: "${targetLabel}"`);
        return null;
      }

      // Determine surrounding field container (form group / fieldset / parent div)
      const container = foundLabelLoc.locator('xpath=./ancestor-or-self::*[self::fieldset or contains(@class, "field") or contains(@class, "form-group") or contains(@class, "input")][1]');
      root = (await container.count()) > 0 ? container : foundLabelLoc.locator('..');

      const rootId = (await root.getAttribute('id')) || '';
      const dataFieldPath = (await root.getAttribute('data-field-path')) || '';
      if (rootId) {
        containerSelector = `[id="${rootId.replace(/"/g, '\\"')}"]`;
      } else if (dataFieldPath) {
        containerSelector = `[data-field-path="${dataFieldPath.replace(/"/g, '\\"')}"]`;
      }
    }

    // 2. Check for standard <select>
    const selectLoc = root.locator('select').first();
    if ((await selectLoc.count()) > 0) {
      const id = (await selectLoc.getAttribute('id')) || '';
      const name = (await selectLoc.getAttribute('name')) || '';
      const selector = id ? `select[id="${id.replace(/"/g, '\\"')}"]` : name ? `select[name="${name}"]` : 'select';

      const rawOptions = await selectLoc.locator('option').allTextContents();
      const options = rawOptions
        .map((o) => o.trim())
        .filter((o) => o && !/^(--|select\b|please select\b)/i.test(o));

      return {
        found: true,
        label: targetLabel,
        type: 'select',
        options,
        locatorSelector: selector,
        containerSelector,
      };
    }

    // 3. Check for radio buttons
    const radioLoc = root.locator('input[type="radio"]');
    const radioCount = await radioLoc.count();
    if (radioCount > 0) {
      const options: string[] = [];
      const name = (await radioLoc.first().getAttribute('name')) || '';
      const selector = name ? `input[type="radio"][name="${name}"]` : 'input[type="radio"]';

      // Scrape text associated with each radio button
      for (let i = 0; i < radioCount; i++) {
        const r = radioLoc.nth(i);
        const id = await r.getAttribute('id');
        let text = '';
        if (id) {
          const l = page.locator(`label[for="${id}"]`);
          if ((await l.count()) > 0) text = (await l.textContent()) || '';
        }
        if (!text) {
          // Check parent label
          const parentLabel = r.locator('xpath=./ancestor::label[1]');
          if ((await parentLabel.count()) > 0) text = (await parentLabel.textContent()) || '';
        }
        if (text) {
          options.push(text.trim());
        }
      }

      return {
        found: true,
        label: targetLabel,
        type: 'radio',
        options,
        locatorSelector: selector,
        containerSelector,
      };
    }

    // 4. Check for textarea
    const textareaLoc = root.locator('textarea').first();
    if ((await textareaLoc.count()) > 0) {
      const id = (await textareaLoc.getAttribute('id')) || '';
      const name = (await textareaLoc.getAttribute('name')) || '';
      const selector = id ? `textarea[id="${id.replace(/"/g, '\\"')}"]` : name ? `textarea[name="${name}"]` : 'textarea';
      return {
        found: true,
        label: targetLabel,
        type: 'textarea',
        options: [],
        locatorSelector: selector,
        containerSelector,
      };
    }

    // 5. Check for standard text / URL input
    const inputLoc = root.locator('input:not([type="hidden"]):not([type="submit"]):not([type="file"])').first();
    if ((await inputLoc.count()) > 0) {
      const id = (await inputLoc.getAttribute('id')) || '';
      const name = (await inputLoc.getAttribute('name')) || '';
      const type = (await inputLoc.getAttribute('type')) || 'text';
      const selector = id
        ? `input[id="${id.replace(/"/g, '\\"')}"]`
        : name
        ? `input[name="${name}"]`
        : 'input:not([type="hidden"]):not([type="submit"]):not([type="file"])';

      return {
        found: true,
        label: targetLabel,
        type: type === 'checkbox' ? 'checkbox' : 'text',
        options: [],
        locatorSelector: selector,
        containerSelector,
      };
    }

    log.warn(`[Realtime DOM] Unrecognized element type under container for "${targetLabel}"`);
    return null;
  } catch (err: any) {
    log.error(`[Realtime DOM] Error scraping field "${targetLabel}": ${err.message}`);
    return null;
  }
}

/**
 * Commits a remediated decision directly into the live Playwright DOM.
 */
export async function commitRemediatedValue(
  page: Page,
  field: ScrapedDomField,
  decision: RemediationDecision
): Promise<CommitResult> {
  const valueToCommit = decision.chosenOptionLabel || decision.value;
  log.info(`[Realtime DOM] Committing "${valueToCommit}" to ${field.type} ("${field.label}")...`);

  try {
    const container = field.containerSelector
      ? page.locator(field.containerSelector).first()
      : page.locator(`label:has-text("${cleanLabel(field.label)}"), legend:has-text("${cleanLabel(field.label)}")`).first().locator('xpath=./ancestor-or-self::*[self::fieldset or contains(@class, "field") or contains(@class, "form-group") or contains(@class, "input")][1]');
    const rootLoc = (await container.count()) > 0 ? container : page;

    if (field.type === 'select') {
      const select = (await rootLoc.locator(field.locatorSelector).count()) > 0
        ? rootLoc.locator(field.locatorSelector).first()
        : page.locator(field.locatorSelector).first();

      await select.selectOption({ label: valueToCommit }).catch(async () => {
        // Fallback: match by value or partial text
        await select.selectOption({ value: valueToCommit });
      });

      // Verify selected value
      const committedText = await select.evaluate((el: HTMLSelectElement) => el.options[el.selectedIndex]?.text || '');
      const committedVal = await select.evaluate((el: HTMLSelectElement) => el.value || '');
      const isCommitted = Boolean(committedText || committedVal);

      return {
        success: isCommitted,
        committedValue: committedText || committedVal || valueToCommit,
      };
    }

    if (field.type === 'radio') {
      // Find matching label inside this question's container first to avoid picking same-labeled options from other questions
      let labelMatch = rootLoc.locator(`label:has-text("${valueToCommit}")`).first();
      if ((await labelMatch.count()) > 0 && (await labelMatch.isVisible().catch(() => false))) {
        await labelMatch.click({ timeout: 3000 });
      } else {
        // Try clicking matching radio input inside container
        const radioInRoot = rootLoc.locator(`input[type="radio"][value*="${valueToCommit}" i]`).first();
        if ((await radioInRoot.count()) > 0) {
          await radioInRoot.check({ force: true, timeout: 3000 });
        } else {
          // Fall back to selector or document-wide matching label
          const radio = page.locator(`${field.locatorSelector}[value*="${valueToCommit}"]`).first();
          if ((await radio.count()) > 0) {
            await radio.check({ force: true, timeout: 3000 });
          } else {
            const docLabelMatch = page.locator(`label:has-text("${valueToCommit}")`).first();
            if ((await docLabelMatch.count()) > 0 && (await docLabelMatch.isVisible().catch(() => false))) {
              await docLabelMatch.click({ timeout: 3000 });
            }
          }
        }
      }

      return {
        success: true,
        committedValue: valueToCommit,
      };
    }

    if (field.type === 'checkbox') {
      const chk = (await rootLoc.locator(field.locatorSelector).count()) > 0
        ? rootLoc.locator(field.locatorSelector).first()
        : page.locator(field.locatorSelector).first();

      if (/^(yes|true|1|agree|accept)\b/i.test(valueToCommit)) {
        await chk.check({ force: true, timeout: 3000 });
      } else {
        await chk.uncheck({ force: true, timeout: 3000 });
      }

      return {
        success: true,
        committedValue: valueToCommit,
      };
    }

    if (field.type === 'text' || field.type === 'textarea') {
      let input = (await rootLoc.locator(field.locatorSelector).count()) > 0
        ? rootLoc.locator(field.locatorSelector).first()
        : page.locator(field.locatorSelector).first();

      const inputType = (await input.getAttribute('type').catch(() => '')) || '';
      if (inputType === 'file' || inputType === 'hidden' || (await input.count()) === 0) {
        input = rootLoc.locator('input:not([type="file"]):not([type="hidden"]):not([type="submit"]), textarea').first();
      }

      await input.fill(valueToCommit, { timeout: 3000 });
      await input.dispatchEvent('change').catch(() => {});
      await input.dispatchEvent('blur').catch(() => {});

      const domVal = await input.inputValue();
      return {
        success: domVal === valueToCommit,
        committedValue: domVal,
      };
    }

    return {
      success: false,
      committedValue: '',
      error: `Unsupported field type "${field.type}"`,
    };
  } catch (err: any) {
    log.error(`[Realtime DOM] Failed to commit value "${valueToCommit}" to ${field.locatorSelector}: ${err.message}`);
    return {
      success: false,
      committedValue: '',
      error: err.message,
    };
  }
}
