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
          await sleep(1000, 1800);
          filledFields.push({
            fieldId: fieldPath,
            label: questionText,
            value: path.basename(resumeLocalPath),
            controlType: 'file',
          });
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
    const yesNoContainer = container.locator('.ashby-application-form-input-yesno, .ashby-application-form-input-yesno-option, button[data-option], button:has-text("Yes")').first();
    if ((await yesNoContainer.count()) > 0) {
      const optVal = answer.toLowerCase() === 'yes' ? 'yes' : 'no';
      const btn = container.locator(`button[data-option="${optVal}"], button:has-text("${answer}")`).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await glideCursor(page, btn, { click: true });
        await sleep(350, 650);
        filledFields.push({ fieldId: fieldPath, label: questionText, value: optVal.toUpperCase(), controlType: 'yes_no_toggle' });
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
      filledFields.push({ fieldId: fieldPath, label: questionText, value: answer, controlType: 'radio' });
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
        filledFields.push({ fieldId: fieldPath, label: questionText, value: shouldCheck ? 'Checked' : 'Unchecked', controlType: 'checkbox' });
      }
      continue;
    }

    // 4. Select / Autocomplete / Combobox
    if (controlType === 'select' || controlType === 'location_autocomplete' || controlType === 'autocomplete') {
      const selectEl = container.locator('select').first();
      if ((await selectEl.count()) > 0 && (await selectEl.isVisible())) {
        await selectEl.selectOption({ label: answer }).catch(async () => {
          await selectEl.selectOption({ value: answer });
        });
      } else {
        const inputEl = container.locator('input.ashby-application-form-input-autocomplete, input[role="combobox"], [role="combobox"] input, input').first();
        const comboboxTrigger = container.locator('[role="combobox"], [aria-haspopup="listbox"], button[class*="toggle"]').first();

        if ((await inputEl.count()) > 0 && (await inputEl.isVisible())) {
          await glideCursor(page, inputEl, { click: true });
          await inputEl.fill('');
          await humanType(page, inputEl, answer);
          await sleep(350, 650);

          const optionLoc = page.locator(`[role="option"]:has-text("${answer}"), div[class*="-option"]:has-text("${answer}")`).first();
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
      filledFields.push({ fieldId: fieldPath, label: questionText, value: answer, controlType: 'select' });
      continue;
    }

    // 5. Standard text / textarea
    const input = container.locator('input, textarea').first();
    if ((await input.count()) > 0 && (await input.isVisible())) {
      await humanType(page, input, answer);
      filledFields.push({ fieldId: fieldPath, label: questionText, value: answer, controlType: 'text' });
      await sleep(350, 650);
    }
  }

  return { filledCount: filledFields.length, filledFields };
}
