/**
 * @fileoverview Stealth Playwright Form Filler for Ashby Job Applications.
 *
 * Implements human-like Bézier cursor movements, micro-jitter typing,
 * and reliable Ashby DOM selector targeting via [data-field-path].
 */

import fs from 'fs';
import path from 'path';
import type { Page, Locator } from 'playwright';
import type { ResolvedField } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AshbyFormFiller');

export const sleep = (min = 400, max = 1200): Promise<void> => {
  if (process.env.NODE_ENV === 'test') {
    return new Promise((resolve) => setTimeout(resolve, 5));
  }
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
};

let globalCursor = { x: 450, y: 250 };

/**
 * Human-like Bézier Curve Cursor Gliding
 * Simulates physical arm kinematics with acceleration, deceleration, micro-tremor, and hover hesitation.
 */
export async function glideCursor(
  page: Page,
  locatorOrElement: Locator,
  options: { click?: boolean } = { click: true }
): Promise<void> {
  const element = locatorOrElement.first();

  try {
    await element.scrollIntoViewIfNeeded();
    await sleep(150, 300);

    const box = await element.boundingBox();
    if (!box) {
      if (options.click) await element.click();
      return;
    }

    const targetX = box.x + box.width * (0.35 + Math.random() * 0.3);
    const targetY = box.y + box.height * (0.35 + Math.random() * 0.3);

    const startX = globalCursor.x;
    const startY = globalCursor.y;

    const distance = Math.hypot(targetX - startX, targetY - startY);
    const steps = Math.min(35, Math.max(16, Math.floor(distance / 25)));

    const midX = (startX + targetX) / 2;
    const midY = (startY + targetY) / 2;
    const deviation = (Math.random() - 0.5) * Math.min(140, distance * 0.35);

    const cp1X = startX + (midX - startX) * 0.6 - deviation * 0.3;
    const cp1Y = startY + (midY - startY) * 0.6 + deviation;
    const cp2X = midX + (targetX - midX) * 0.6 + deviation * 0.2;
    const cp2Y = midY + (targetY - midY) * 0.6 - deviation * 0.5;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);

      const cx =
        Math.pow(1 - ease, 3) * startX +
        3 * Math.pow(1 - ease, 2) * ease * cp1X +
        3 * (1 - ease) * Math.pow(ease, 2) * cp2X +
        Math.pow(ease, 3) * targetX;

      const cy =
        Math.pow(1 - ease, 3) * startY +
        3 * Math.pow(1 - ease, 2) * ease * cp1Y +
        3 * (1 - ease) * Math.pow(ease, 2) * cp2Y +
        Math.pow(ease, 3) * targetY;

      const jitterX = (Math.random() - 0.5) * 1.2;
      const jitterY = (Math.random() - 0.5) * 1.2;

      await page.mouse.move(cx + jitterX, cy + jitterY);
      await sleep(8, 16);
    }

    await page.mouse.move(targetX, targetY);
    globalCursor = { x: targetX, y: targetY };

    if (options.click) {
      await sleep(100, 220);
      await page.mouse.down();
      await sleep(60, 120);
      await page.mouse.up();
      await sleep(150, 300);
    }
  } catch {
    if (options.click) {
      await element.click().catch(() => {});
    }
  }
}

/**
 * Human-like character-by-character typing with natural jitter and glide.
 */
export async function humanType(page: Page, element: Locator, text: string): Promise<void> {
  await glideCursor(page, element, { click: true });
  await sleep(150, 250);

  await element.fill('');
  await sleep(150, 250);

  const str = String(text);
  if (process.env.NODE_ENV === 'test') {
    await element.fill(str);
    return;
  }

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    await page.keyboard.type(char);

    let delay = Math.floor(Math.random() * (100 - 45 + 1)) + 45;
    if ([' ', '.', ',', '?', '!', '-'].includes(char)) {
      delay += Math.floor(Math.random() * 120) + 50;
    }
    await new Promise((r) => setTimeout(r, delay));
  }

  await sleep(350, 750);
}

export interface FilledAshbyField {
  fieldId: string;
  label: string;
  value: string;
  controlType: string;
}

/**
 * Iterates through resolved form fields and fills the Ashby application form.
 * Performs live DOM state verification before accounting fields as successfully filled.
 */
export async function fillAshbyForm(
  page: Page,
  resolvedFields: ResolvedField[],
  resumeLocalPath: string
): Promise<{ filledCount: number; filledFields: FilledAshbyField[] }> {
  const filledFields: FilledAshbyField[] = [];

  for (let i = 0; i < resolvedFields.length; i++) {
    const field = resolvedFields[i];
    const fieldPath = field.fieldId || field.name;
    const questionText = field.label || fieldPath;
    const rawAnswer = field.value;
    const controlType = (field.type || 'text').toLowerCase();
    if (!field.isRequired && !String(rawAnswer ?? '').trim()) continue;

    // Check for resume upload
    if (fieldPath === '_systemfield_resume' || controlType === 'file') {
      const container = page.locator(`[data-field-path="${fieldPath}"]`).first();
      if ((await container.count()) > 0 && fs.existsSync(resumeLocalPath)) {
        log.info(`[AshbyFormFiller] Uploading resume: ${resumeLocalPath}`);
        const fileInput = container.locator('input[type="file"]').first();
        if ((await fileInput.count()) > 0) {
          await fileInput.setInputFiles(resumeLocalPath);
          await sleep(500, 800);

          // Dispatch synthetic change and input events to trigger React controlled state
          await fileInput.evaluate((input: HTMLInputElement) => {
            const changeEvent = new Event('change', { bubbles: true });
            Object.defineProperty(changeEvent, 'target', { value: input });
            input.dispatchEvent(changeEvent);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }).catch(() => {});

          await sleep(800, 1500);

          // Live DOM verification for file upload
          const isUploaded = await container.evaluate((el) => {
            const input = el.querySelector('input[type="file"]') as HTMLInputElement | null;
            const hasFiles = Boolean(input && input.files && input.files.length > 0);
            const hasChip = Boolean(
              el.querySelector('.ashby-file-preview, .file-preview, [data-testid*="file-name"]')
            );
            return hasFiles || hasChip;
          }).catch(() => false);

          if (isUploaded) {
            filledFields.push({
              fieldId: fieldPath,
              label: questionText,
              value: path.basename(resumeLocalPath),
              controlType: 'file',
            });
          } else {
            log.warn(`[AshbyFormFiller] Resume upload could not be verified on DOM for ${fieldPath}`);
          }
        }
      }
      continue;
    }

    if (rawAnswer === undefined || rawAnswer === null || String(rawAnswer).trim() === '') {
      continue;
    }

    const answer = String(rawAnswer).trim();
    const container = page.locator(`[data-field-path="${fieldPath}"]`).first();
    if ((await container.count()) === 0) {
      continue;
    }

    await container.scrollIntoViewIfNeeded();
    await sleep(250, 500);

    // 1. Yes/No Button Toggle
    const yesNoContainer = container.locator(
      '.ashby-application-form-input-yesno, .ashby-application-form-input-yesno-option, button[data-option], button:has-text("Yes")'
    ).first();
    if ((await yesNoContainer.count()) > 0) {
      const optVal = answer.toLowerCase() === 'yes' ? 'yes' : 'no';
      const btn = container.locator(`button[data-option="${optVal}"], button:has-text("${answer}")`).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await glideCursor(page, btn, { click: true });
        await sleep(350, 650);

        // Live DOM verification: verify aria-pressed="true" or selected/active class
        const isVerified = await btn.evaluate((el) => {
          const ariaPressed = el.getAttribute('aria-pressed');
          const className = el.className || '';
          return ariaPressed === 'true' || /selected|active/i.test(className);
        }).catch(() => false);

        if (isVerified) {
          filledFields.push({
            fieldId: fieldPath,
            label: questionText,
            value: optVal.toUpperCase(),
            controlType: 'yes_no_toggle',
          });
        } else {
          log.warn(`[AshbyFormFiller] Yes/No button toggle not verified on DOM for ${fieldPath}`);
        }
      }
      continue;
    }

    // 2. Radio Button Group
    if (controlType === 'radio') {
      const radioLabel = container.locator(`label:has-text("${answer}")`).first();
      const radioInput = container.locator(`input[type="radio"][value="${answer}"]`).first();

      if ((await radioLabel.count()) > 0 && (await radioLabel.isVisible())) {
        await glideCursor(page, radioLabel, { click: true });
      } else if ((await radioInput.count()) > 0) {
        await glideCursor(page, radioInput, { click: true });
      }
      await sleep(350, 650);

      // Live DOM verification: check input[type="radio"]:checked or active label
      const isVerified = await container.evaluate((el, ans) => {
        const checkedRadios = Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked'));
        if (checkedRadios.length > 0) {
          for (const r of checkedRadios) {
            if (r.value.toLowerCase() === ans.toLowerCase()) return true;
            const l = r.closest('label') || el.querySelector(`label[for="${r.id}"]`);
            if (l && (l.textContent || '').toLowerCase().includes(ans.toLowerCase())) return true;
          }
          return true;
        }
        const activeLabels = Array.from(
          el.querySelectorAll('label, div[role="radio"], button[role="radio"]')
        );
        for (const l of activeLabels) {
          const cls = l.className || '';
          const ariaChecked = l.getAttribute('aria-checked');
          if ((ariaChecked === 'true' || /selected|active/i.test(cls)) && (l.textContent || '').toLowerCase().includes(ans.toLowerCase())) {
            return true;
          }
        }
        return false;
      }, answer).catch(() => false);

      if (isVerified) {
        filledFields.push({ fieldId: fieldPath, label: questionText, value: answer, controlType: 'radio' });
      } else {
        log.warn(`[AshbyFormFiller] Radio button not verified on DOM for ${fieldPath}`);
      }
      continue;
    }

    // 3. Checkbox
    if (controlType === 'checkbox') {
      const cb = container.locator('input[type="checkbox"]').first();
      if ((await cb.count()) > 0) {
        const shouldCheck = answer === 'true' || answer.toLowerCase() === 'yes' || answer === '1';
        const isChecked = await cb.isChecked();
        if (shouldCheck !== isChecked) {
          await glideCursor(page, cb, { click: true });
        }
        await sleep(350, 650);

        // Live DOM verification: input[type="checkbox"]:checked matches desired state
        const currentChecked = await cb.isChecked().catch(() => false);
        if (currentChecked === shouldCheck) {
          filledFields.push({
            fieldId: fieldPath,
            label: questionText,
            value: shouldCheck ? 'Checked' : 'Unchecked',
            controlType: 'checkbox',
          });
        } else {
          log.warn(`[AshbyFormFiller] Checkbox state mismatch for ${fieldPath}: expected ${shouldCheck}, got ${currentChecked}`);
        }
      }
      continue;
    }

    // 4. Select / Autocomplete / Combobox
    if (controlType === 'select' || controlType === 'location_autocomplete' || controlType === 'autocomplete') {
      const selectEl = container.locator('select').first();
      if ((await selectEl.count()) > 0 && (await selectEl.isVisible())) {
        await selectEl.selectOption({ label: answer }, { timeout: 2000 }).catch(async () => {
          await selectEl.selectOption({ value: answer }, { timeout: 2000 });
        }).catch(() => {});
      } else {
        const inputEl = container.locator(
          'input.ashby-application-form-input-autocomplete, input[role="combobox"], [role="combobox"] input, input'
        ).first();
        const comboboxTrigger = container.locator(
          '[role="combobox"], [aria-haspopup="listbox"], button[class*="toggle"]'
        ).first();

        if ((await inputEl.count()) > 0 && (await inputEl.isVisible())) {
          await glideCursor(page, inputEl, { click: true });
          await inputEl.fill('');
          await humanType(page, inputEl, answer);
          await sleep(350, 650);

          const optionLoc = page.locator(
            `[role="option"]:has-text("${answer}"), div[class*="-option"]:has-text("${answer}")`
          ).first();
          if ((await optionLoc.count()) > 0 && (await optionLoc.isVisible())) {
            await glideCursor(page, optionLoc, { click: true });
          } else {
            await page.keyboard.press('ArrowDown');
            await sleep(150, 300);
            await page.keyboard.press('Enter');
          }
        } else if ((await comboboxTrigger.count()) > 0) {
          await glideCursor(page, comboboxTrigger, { click: true });
          await sleep(300, 500);
          const optionLoc = page.locator(`[role="option"]:has-text("${answer}"), div:has-text("${answer}")`).first();
          if ((await optionLoc.count()) > 0 && (await optionLoc.isVisible())) {
            await glideCursor(page, optionLoc, { click: true });
          } else {
            await page.keyboard.type(answer);
            await page.keyboard.press('Enter');
          }
        }
      }
      await sleep(350, 650);

      // Live DOM verification: verify select value or selected option text
      const isVerified = await container.evaluate((el, ans) => {
        const select = el.querySelector('select');
        if (select) {
          const opt = select.options[select.selectedIndex];
          if (opt && (opt.text.toLowerCase().includes(ans.toLowerCase()) || opt.value.toLowerCase() === ans.toLowerCase())) {
            return true;
          }
          return false;
        }
        const input = el.querySelector('input');
        if (input && input.value && (input.value.toLowerCase().includes(ans.toLowerCase()) || ans.toLowerCase().includes(input.value.toLowerCase()))) {
          return true;
        }
        const selectedDisplay = el.querySelector(
          '[class*="selected"], [class*="singleValue"], [role="option"][aria-selected="true"], [data-selected="true"]'
        );
        if (selectedDisplay && (selectedDisplay.textContent || '').toLowerCase().includes(ans.toLowerCase())) {
          return true;
        }
        return false;
      }, answer).catch(() => false);

      if (isVerified) {
        filledFields.push({ fieldId: fieldPath, label: questionText, value: answer, controlType: 'select' });
      } else {
        log.warn(`[AshbyFormFiller] Select / Autocomplete not verified on DOM for ${fieldPath}`);
      }
      continue;
    }

    // 5. Standard text / textarea
    const input = container.locator('input, textarea').first();
    if ((await input.count()) > 0 && (await input.isVisible())) {
      await humanType(page, input, answer);
      await sleep(350, 650);

      // Live DOM verification: verify input.inputValue() equals or matches answer
      const val = await input.inputValue().catch(() => '');
      if (val.trim() === answer.trim() || val.toLowerCase().includes(answer.toLowerCase())) {
        filledFields.push({ fieldId: fieldPath, label: questionText, value: answer, controlType: 'text' });
      } else {
        log.warn(`[AshbyFormFiller] Text / textarea value mismatch for ${fieldPath}: expected "${answer}", got "${val}"`);
      }
    }
  }

  return { filledCount: filledFields.length, filledFields };
}

/**
 * Validates that all required fields are committed with non-empty, valid state on the live DOM.
 * Discovers required fields from provided paths as well as HTML required/aria-required attributes.
 */
export async function verifyRequiredFieldsCommitted(
  page: Page,
  requiredFieldPaths: string[] = []
): Promise<{ allCommitted: boolean; missingFields: string[] }> {
  try {
    const missing = await page.evaluate((fieldPaths: string[]) => {
      const missingList: string[] = [];

      // Discover any additional field marked required on DOM
      const domRequiredPaths: string[] = [];
      const allContainers = Array.from(document.querySelectorAll<HTMLElement>('[data-field-path]'));
      for (const container of allContainers) {
        const path = container.getAttribute('data-field-path');
        if (!path) continue;
        const hasRequiredMarker = Boolean(
          container.querySelector('[required], [aria-required="true"]') ||
          container.querySelector('label')?.textContent?.includes('*')
        );
        if (hasRequiredMarker && !domRequiredPaths.includes(path)) {
          domRequiredPaths.push(path);
        }
      }

      const allPathsToCheck = Array.from(new Set([...fieldPaths, ...domRequiredPaths]));

      for (const path of allPathsToCheck) {
        const selector = (window.CSS && window.CSS.escape)
          ? `[data-field-path="${window.CSS.escape(path)}"]`
          : `[data-field-path="${path.replace(/["\\]/g, '\\$&')}"]`;

        const container = document.querySelector(selector);
        if (!container) {
          missingList.push(path);
          continue;
        }

        // 1. Resume / File upload
        const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
        const hasPreviewChip = Boolean(
          container.querySelector('.ashby-file-preview, .file-preview, [data-testid*="file-name"]')
        );
        if (fileInput || hasPreviewChip || path === '_systemfield_resume') {
          const hasFile = Boolean(fileInput?.files && fileInput.files.length > 0);
          if (hasFile || hasPreviewChip) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // 2. Yes/No button toggle
        const toggleButtons = container.querySelectorAll<HTMLButtonElement>(
          'button[data-option], .ashby-application-form-input-yesno button, .ashby-application-form-input-yesno-option button'
        );
        if (toggleButtons.length > 0) {
          let isTogglePressed = false;
          for (const btn of Array.from(toggleButtons)) {
            const pressed = btn.getAttribute('aria-pressed');
            const cls = btn.className || '';
            if (pressed === 'true' || /selected|active/i.test(cls)) {
              isTogglePressed = true;
              break;
            }
          }
          if (isTogglePressed) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // 3. Radio button group
        const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
        if (radios.length > 0) {
          const checkedRadio = container.querySelector('input[type="radio"]:checked');
          const activeRadio = container.querySelector(
            '[role="radio"][aria-checked="true"], label[class*="selected"], label[class*="active"]'
          );
          if (checkedRadio || activeRadio) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // 4. Checkbox
        const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        if (checkboxes.length > 0) {
          const checkedCb = container.querySelector(
            'input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]'
          );
          if (checkedCb) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // 5. Select element
        const select = container.querySelector('select');
        if (select) {
          const val = select.value ? select.value.trim() : '';
          if (val) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // 6. Combobox / Autocomplete
        const combobox = container.querySelector(
          '[role="combobox"], [aria-haspopup="listbox"], input.ashby-application-form-input-autocomplete'
        );
        if (combobox) {
          const comboInput = container.querySelector<HTMLInputElement>('input');
          const hasVal = Boolean(comboInput?.value && comboInput.value.trim() !== '');
          const hasOptionSelected = Boolean(
            container.querySelector('[class*="selected"], [class*="singleValue"], [role="option"][aria-selected="true"]')
          );
          if (hasVal || hasOptionSelected) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // 7. Text input / Textarea
        const textInput = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]), textarea'
        );
        if (textInput) {
          const hasText = Boolean(textInput.value && textInput.value.trim() !== '');
          if (hasText) {
            continue;
          } else {
            missingList.push(path);
            continue;
          }
        }

        // Unrecognized empty container
        missingList.push(path);
      }

      return missingList;
    }, requiredFieldPaths);

    return {
      allCommitted: missing.length === 0,
      missingFields: missing,
    };
  } catch (err: any) {
    log.error(`[AshbyFormFiller] Error evaluating DOM required fields: ${err.message}`);
    return {
      allCommitted: false,
      missingFields: requiredFieldPaths,
    };
  }
}
