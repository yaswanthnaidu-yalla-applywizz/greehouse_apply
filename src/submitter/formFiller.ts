/**
 * @fileoverview Playwright Form Filler Engine with Cascading Field Detection (Phase V2-4b).
 *
 * Automatically populates resolved candidate answers into Greenhouse job application forms
 * with resilient DOM selector fallback hierarchies, randomized 300-800ms human-like jitter,
 * robust resume temporary file management with guaranteed cleanup, and dynamic cascade
 * detection loops for conditionally revealed fields (e.g. Hispanic/Latino -> Race).
 */

import fs from 'fs';
import type { Page, Locator } from 'playwright';
import { downloadResumeTempFile } from '../db/storage.js';
import { getUnmappedVisibleFields } from './cascadeDetector.js';
import { AnswerResolver } from '../resolver/answerResolver.js';
import { getProfile, getCompanyEmail, type ProfileRow } from '../db/profiles.js';
import { getOrParseResume, type ResumeParsedRow } from '../resolver/tier2ResumeParse.js';
import { findAnswersByCandidate, type QABankRow } from '../db/qaBank.js';
import type {
  ResolvedField,
  CandidateJobApplication,
} from '../types/index.js';
import type { ApplicationRow } from '../db/applications.js';

export interface FormFillerOptions {
  /** Minimum delay in milliseconds between field fills (default: 300) */
  minJitterMs?: number;
  /** Maximum delay in milliseconds between field fills (default: 800) */
  maxJitterMs?: number;
  /** Interaction timeout in milliseconds per element (default: 5000) */
  timeoutMs?: number;
  /** Maximum number of dynamic cascading cycles (default: 3) */
  maxCascadeCycles?: number;
  /** Max time allowed for cascade resolution in ms (default: 2000) */
  maxCascadeTimeoutMs?: number;
}

export interface FieldFillResult {
  fieldId: string;
  name: string;
  type: string;
  label: string;
  valuePopulated: string;
  success: boolean;
  error?: string;
}

export interface FormFillSummary {
  applicationId: string;
  jobUrl: string;
  totalFields: number;
  filledFields: number;
  failedFields: number;
  results: FieldFillResult[];
}

/**
 * Generates a randomized delay between [minMs, maxMs].
 */
export function sleepRandomJitter(minMs: number = 300, maxMs: number = 800): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Escapes characters for CSS ID selectors (#id).
 */
function escapeId(str: string): string {
  if (!str) return '';
  return str.replace(/([\[\]#.:(),"'\\/])/g, '\\$1');
}

/**
 * Escapes characters for CSS attribute value selectors ([name="val"]).
 */
function escapeAttr(str: string): string {
  if (!str) return '';
  return str.replace(/["\\]/g, '\\$&');
}

/**
 * Tries a list of selector candidates and returns the first visible/attached Locator.
 */
async function findElementLocator(
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

function normalizeBooleanValue(value: string): 'Yes' | 'No' | null {
  const normalized = value.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'agree', 'checked'].includes(normalized)) return 'Yes';
  if (['no', 'n', 'false', '0', 'disagree', 'unchecked'].includes(normalized)) return 'No';
  return null;
}

async function clickBooleanOption(
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
      console.log(
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

/**
 * Fills a single resolved field into the active Playwright page DOM.
 */
export async function fillSingleField(
  page: Page,
  field: ResolvedField,
  applywizzId: string,
  tempFilesToClean: string[],
  options: FormFillerOptions = {}
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
    success: false,
  };

  // 0. Cover Letter Prohibition - NEVER fill or upload cover letters per policy
  if (/cover\s*letter|cover_letter/i.test(`${name} ${fieldId} ${label}`)) {
    console.log(`[Form Filler] ⏭️ Skipping cover letter field "${label}" (${name}) per policy.`);
    fillResult.success = true;
    fillResult.valuePopulated = '';
    return fillResult;
  }

  // Strip +1 country code prefix from phone numbers
  if (fieldId === 'phone' || name === 'phone' || /phone/i.test(label)) {
    val = val.replace(/^\+?1[\s.-]*/, '').replace(/^\+/, '').replace(/\s+/g, ' ').trim();
    fillResult.valuePopulated = val;
  }

  // Skip empty non-required fields if no value provided
  if (!val && rawType !== 'file') {
    fillResult.success = true;
    return fillResult;
  }

  try {
    if (rawType === 'file' || fieldId === 'resume' || name.toLowerCase().includes('resume')) {
      // Policy: The bot ONLY fills resume file upload. Never fill or attach cover letters.
      const isResume = fieldId === 'resume' || name.toLowerCase().includes('resume') || /resume|cv\b/i.test(label);
      if (!isResume || /cover/i.test(`${name} ${fieldId} ${label}`)) {
        console.log(`[Form Filler] ⏭️ Skipping non-resume / cover letter file upload ("${label}").`);
        fillResult.success = true;
        fillResult.valuePopulated = '';
        return fillResult;
      }

      // ==========================================
      // File Upload (Master Resume PDF ONLY)
      // ==========================================
      const fileSelectors = [
        (field as any).metadata?.selector,
        'input[type="file"]#resume',
        'input[type="file"][name*="resume"]',
        'input[type="file"][id*="resume"]',
        '#resume_file',
        `input[type="file"]#${escapeId(name)}`,
        `input[type="file"]#${escapeId(fieldId)}`,
      ].filter(Boolean);

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
          tempFilesToClean.push(tempResumePath);
        } catch (dlErr: any) {
          const localCandidates = [
            `./resumes/${applywizzId}.pdf`,
            `./resumes/${applywizzId}_resume.pdf`,
            `./resumes/my-resume.pdf`,
          ];
          const foundLocal = localCandidates.find((p) => fs.existsSync(p));
          if (foundLocal) {
            tempResumePath = foundLocal;
          } else {
            throw new Error(`Could not obtain resume PDF: ${dlErr.message}`);
          }
        }
      }

      await found.locator.setInputFiles(tempResumePath, { timeout: timeoutMs });
      fillResult.valuePopulated = tempResumePath;
      fillResult.success = true;
      console.log(`[Form Filler] ✅ Uploaded resume for ${applywizzId}`);
    } else if (rawType === 'textarea') {
      // ==========================================
      // Textarea
      // ==========================================
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
      ].filter(Boolean);

      const found = await findElementLocator(page, textareaSelectors, timeoutMs);
      if (found) {
        await found.locator.scrollIntoViewIfNeeded().catch(() => {});
        await found.locator.click().catch(() => {});
        await found.locator.fill(val, { timeout: timeoutMs });
        await found.locator.evaluate((el: HTMLTextAreaElement) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch(() => {});
        fillResult.success = true;
      } else {
        const labelLoc = page.locator(`label:has-text("${label}")`).first();
        if ((await labelLoc.count()) > 0) {
          const targetTextarea = labelLoc.locator('..').locator('textarea').first();
          if ((await targetTextarea.count()) > 0) {
            await targetTextarea.scrollIntoViewIfNeeded().catch(() => {});
            await targetTextarea.click().catch(() => {});
            await targetTextarea.fill(val, { timeout: timeoutMs });
            await targetTextarea.evaluate((el: HTMLTextAreaElement) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
            fillResult.success = true;
          } else {
            throw new Error(`Textarea not found under label for ${name} (${label})`);
          }
        } else {
          throw new Error(`Textarea not found for ${name} (${label})`);
        }
      }
    } else if (rawType === 'select') {
      // ==========================================
      // Select Dropdown (Native, Select2, React-Select)
      // ==========================================
      const booleanValue = normalizeBooleanValue(val);
      const selectValue = booleanValue || val;
      const selectSelectors = [
        (field as any).metadata?.selector,
        `select#${escapeId(name)}`,
        `select#${escapeId(fieldId)}`,
        `select#${escapeId(name.replace(/_/g, '-'))}`,
        `select#${escapeId(fieldId.replace(/_/g, '-'))}`,
        `#${escapeId(name)}`,
        `#${escapeId(fieldId)}`,
        `#${escapeId(name.replace(/_/g, '-'))}`,
        `#${escapeId(fieldId.replace(/_/g, '-'))}`,
        `select[name="${escapeAttr(name)}"]`,
        `select[name="${escapeAttr(fieldId)}"]`,
        `input[id*="${escapeAttr(name)}"]`,
        `input[id*="${escapeAttr(fieldId)}"]`,
      ].filter(Boolean);

      // Retry finding locator if field was conditionally rendered
      let found = await findElementLocator(page, selectSelectors, timeoutMs);
      if (!found) {
        await page.waitForTimeout(400);
        found = await findElementLocator(page, selectSelectors, timeoutMs);
      }

      // Fallback: search by label
      if (!found) {
        const labelLoc = page.locator(`label:has-text("${label}")`).first();
        if ((await labelLoc.count()) > 0) {
          const parent = labelLoc.locator('..').first();
          const candidateSelect = parent.locator('select, input[role="combobox"], .select__input, .select2-selection').first();
          if ((await candidateSelect.count()) > 0) {
            found = { locator: candidateSelect, selector: `label("${label}") -> dropdown` };
          }
        }
      }

      if (found) {
        const tagName = await found.locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'SELECT');
        const role = await found.locator.getAttribute('role').catch(() => null);
        const className = (await found.locator.getAttribute('class').catch(() => '')) || '';

        if (tagName === 'INPUT' || tagName === 'DIV' || tagName === 'BUTTON' || role === 'combobox' || className.includes('select__input')) {
          // Modern React-Select combobox input
          await found.locator.scrollIntoViewIfNeeded().catch(() => {});
          await found.locator.click({ force: true }).catch(() => {});
          await page.waitForTimeout(150);
          await found.locator.pressSequentially(selectValue, { delay: 35 });
          await page.waitForTimeout(350);

          const escapedVal = selectValue.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const optionCandidates = page.locator('.select__option:not(.iti__country), [id*="-option"]:not(.iti__country), [role="option"]:not(.iti__country)');

          // 1. Exact match
          let matchedOpt = optionCandidates.filter({
            hasText: new RegExp(`^${escapedVal}$`, 'i'),
          }).first();

          // 2. Prefix match (e.g., "United States" matching "United States +1")
          if ((await matchedOpt.count()) === 0) {
            matchedOpt = optionCandidates.filter({
              hasText: new RegExp(`^${escapedVal}`, 'i'),
            }).first();
          }

          // 3. Substring / fuzzy match
          if ((await matchedOpt.count()) === 0) {
            matchedOpt = optionCandidates.filter({
              hasText: new RegExp(escapedVal, 'i'),
            }).first();
          }

          if ((await matchedOpt.count()) > 0) {
            await matchedOpt.scrollIntoViewIfNeeded().catch(() => {});
            await matchedOpt.click({ force: true, timeout: 2500 });
            if (booleanValue) {
              console.log(
                `[Submitter] Boolean field "${fieldId}" → selector: ${found.selector} → value: ${booleanValue} → clicked ✅`
              );
            }
          } else {
            await page.keyboard.press('Enter').catch(() => {});
            await page.keyboard.press('Tab').catch(() => {});
          }

          // If this was hispanic_ethnicity, give DOM time to render conditional race field
          if (fieldId.includes('hispanic') || name.includes('hispanic')) {
            await page.waitForTimeout(500);
          }

          fillResult.success = true;
        } else {
          // Native HTML <select> (supports Select2 hidden elements via force: true)
          let selected = false;
          // 1. Try exact label match
          try {
            await found.locator.selectOption({ label: selectValue }, { force: true, timeout: 2000 });
            selected = true;
          } catch {}

          // 2. Try value match
          if (!selected) {
            try {
              await found.locator.selectOption({ value: selectValue }, { force: true, timeout: 2000 });
              selected = true;
            } catch {}
          }

          // 3. Try fuzzy/case-insensitive option match
          if (!selected) {
            try {
              const optionsList = await found.locator.locator('option').allInnerTexts();
              const lowerVal = selectValue.toLowerCase().trim();
              const matchedOpt = optionsList.find((opt) => {
                const o = opt.toLowerCase().trim();
                return o === lowerVal || o.startsWith(lowerVal) || o.includes(lowerVal) || lowerVal.includes(o);
              });
              if (matchedOpt) {
                await found.locator.selectOption({ label: matchedOpt.trim() }, { force: true, timeout: 2000 });
                selected = true;
              }
            } catch {}
          }

          // Trigger change events natively and on jQuery for Select2 UI sync
          await found.locator.evaluate((el: HTMLSelectElement) => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof (window as any).$ !== 'undefined') {
              (window as any).$(el).trigger('change');
            }
          }).catch(() => {});

          if (selected) {
            if (booleanValue) {
              console.log(
                `[Submitter] Boolean field "${fieldId}" → selector: ${found.selector} → value: ${booleanValue} → selected ✅`
              );
            }
            fillResult.success = true;
          } else {
            throw new Error(`Could not select option "${val}" in ${found.selector}`);
          }
        }
      } else {
        // Fallback for custom Select2 or React-Select dropdowns
        const select2Trigger = page.locator(
          `[id*="select2-${escapeId(name)}"], [id*="select2-${escapeId(fieldId)}"], .select2-selection, .css-control`
        ).first();

        const count = await select2Trigger.count();
        if (count > 0) {
          await select2Trigger.click();
          await page.waitForTimeout(300);
          const optLoc = page.locator(`.select2-results__option:not(.iti__country), [role="option"]:not(.iti__country)`).filter({ hasText: val }).first();
          const optCount = await optLoc.count();
          if (optCount > 0) {
            await optLoc.click({ force: true });
            fillResult.success = true;
          } else {
            throw new Error(`Custom select option "${val}" not found`);
          }
        } else {
          throw new Error(`Select element not found for ${name}`);
        }
      }
    } else if (rawType === 'radio') {
      // ==========================================
      // Radio Buttons
      // ==========================================
      const radioGroup = page.locator(
        `input[type="radio"][name="${escapeAttr(name)}"], input[type="radio"][name="${escapeAttr(fieldId)}"]`
      );
      const count = await radioGroup.count();

      let checked = false;

      const booleanValue = normalizeBooleanValue(val);
      if (count > 0) {
        for (let r = 0; r < count; r++) {
          const radio = radioGroup.nth(r);
          const radioId = await radio.getAttribute('id');
          const radioVal = await radio.getAttribute('value');

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
          const cleanTarget = val.toLowerCase().trim();

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
    } else if (rawType === 'checkbox') {
      // ==========================================
      // Checkbox
      // ==========================================
      const booleanValue = normalizeBooleanValue(val);
      const isAffirmative = booleanValue === 'Yes';
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
          console.log(
            `[Submitter] Boolean field "${fieldId}" → selector: ${checkboxSelector} → value: Yes`
          );
          await found.locator.scrollIntoViewIfNeeded().catch(() => {});
          await found.locator.check({ force: true, timeout: 3000 }).catch(async () => {
            await clickBooleanOption(found.locator, fieldId, checkboxSelector, 'Yes');
          });
          console.log(`[Submitter] Boolean field "${fieldId}" → selector: ${checkboxSelector} → clicked ✅`);
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
    } else if (rawType === 'location_autocomplete') {
      // ==========================================
      // Location Autocomplete (Native & React-Select)
      // ==========================================
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
      ].filter(Boolean);

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
          await page.keyboard.press('Tab').catch(() => {});
          fillResult.success = true;
        }
      } else {
        throw new Error(`Location autocomplete input not found for ${name}`);
      }
    } else {
      // ==========================================
      // Default: Standard Text Input / Auto-Detected Dropdown
      // ==========================================
      const textSelectors: (string | undefined)[] = [
        (field as any).metadata?.selector,
      ];

      // Prioritize standard field selectors
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
      } else if (fieldId === 'email' || /email/i.test(label)) {
        textSelectors.push(
          '#email',
          'input#email',
          'input[name="email"]',
          'input[name="job_application[email]"]',
          'input[type="email"]',
          'input[autocomplete="email"]'
        );
      } else if (fieldId === 'phone' || /phone|mobile/i.test(label)) {
        textSelectors.push(
          '#phone',
          'input#phone',
          'input[name="phone"]',
          'input[name="job_application[phone]"]',
          'input[type="tel"]',
          'input[id*="phone"]'
        );
      }

      textSelectors.push(
        `input#${escapeId(name)}`,
        `input#${escapeId(fieldId)}`,
        `input#${escapeId(name.replace(/_/g, '-'))}`,
        `input#${escapeId(fieldId.replace(/_/g, '-'))}`,
        `#${escapeId(name)}`,
        `#${escapeId(fieldId)}`,
        `#${escapeId(name.replace(/_/g, '-'))}`,
        `#${escapeId(fieldId.replace(/_/g, '-'))}`,
        `input[name="${escapeAttr(name)}"]`,
        `input[name="${escapeAttr(fieldId)}"]`,
        `input[id*="${escapeAttr(fieldId)}"]`,
        `input[id*="${escapeAttr(name)}"]`
      );

      const validSelectors = textSelectors.filter(Boolean) as string[];
      let found = await findElementLocator(page, validSelectors, timeoutMs);

      // Label fallback if not found by selector
      if (!found) {
        const labelLoc = page.locator(`label:has-text("${label}")`).first();
        if ((await labelLoc.count()) > 0) {
          const parent = labelLoc.locator('..').first();
          const targetInput = parent.locator('input, select, textarea').first();
          if ((await targetInput.count()) > 0) {
            found = { locator: targetInput, selector: `label("${label}") -> control` };
          }
        }
      }

      if (found) {
        const tagName = await found.locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'INPUT');
        const role = await found.locator.getAttribute('role').catch(() => null);
        const className = await found.locator.getAttribute('class').catch(() => '');

        if (tagName === 'SELECT') {
          // Element was misclassified as text but is actually a native select
          let selected = false;
          try {
            await found.locator.selectOption({ label: val }, { force: true, timeout: 2000 });
            selected = true;
          } catch {}
          if (!selected) {
            try {
              await found.locator.selectOption({ value: val }, { force: true, timeout: 2000 });
              selected = true;
            } catch {}
          }
          await found.locator.evaluate((el: HTMLSelectElement) => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof (window as any).$ !== 'undefined') {
              (window as any).$(el).trigger('change');
            }
          }).catch(() => {});
          fillResult.success = true;
        } else if (role === 'combobox' || (className && className.includes('select__input'))) {
          // Element was misclassified as text but is actually a React-Select combobox
          await found.locator.scrollIntoViewIfNeeded().catch(() => {});
          await found.locator.click({ force: true }).catch(() => {});
          await page.waitForTimeout(150);
          await found.locator.pressSequentially(val, { delay: 35 });
          await page.waitForTimeout(350);

          const escapedVal = val.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const optionCandidates = page.locator('.select__option:not(.iti__country), [id*="-option"]:not(.iti__country), [role="option"]:not(.iti__country)');

          let matchedOpt = optionCandidates.filter({ hasText: new RegExp(`^${escapedVal}$`, 'i') }).first();
          if ((await matchedOpt.count()) === 0) {
            matchedOpt = optionCandidates.filter({ hasText: new RegExp(`^${escapedVal}`, 'i') }).first();
          }
          if ((await matchedOpt.count()) === 0) {
            matchedOpt = optionCandidates.filter({ hasText: new RegExp(escapedVal, 'i') }).first();
          }

          if ((await matchedOpt.count()) > 0) {
            await matchedOpt.click({ force: true, timeout: 2500 }).catch(() => {});
          } else {
            await page.keyboard.press('Enter').catch(() => {});
            await page.keyboard.press('Tab').catch(() => {});
          }
          fillResult.success = true;
        } else {
          // Standard text input
          await found.locator.scrollIntoViewIfNeeded().catch(() => {});
          await found.locator.click().catch(() => {});
          await found.locator.fill(val, { timeout: timeoutMs });
          await found.locator.evaluate((el: HTMLInputElement) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }).catch(() => {});
          fillResult.success = true;

          const isEmailField =
            fieldId === 'email' ||
            name === 'email' ||
            /email/i.test(label) ||
            /email/i.test(name) ||
            /email/i.test(fieldId);
          if (isEmailField) {
            console.log(`[Form Filler] 📧 Email field filled with company email: ${val} (source: company_email)`);
          }

          const isPhoneField =
            fieldId === 'phone' ||
            name === 'phone' ||
            /phone|mobile/i.test(label) ||
            /phone|mobile/i.test(name) ||
            /phone|mobile/i.test(fieldId);
          if (isPhoneField) {
            try {
              const cleanApplywizzId = (applywizzId || '').trim().toUpperCase();
              const isAkshitha = cleanApplywizzId === 'AWL-31428' || cleanApplywizzId.includes('AKSHITHA');
              const isYaswanth = cleanApplywizzId === 'AWL-YASWANTH';

              const candProfile = applywizzId ? await getProfile(applywizzId) : null;
              const isUs = isAkshitha || candProfile?.country_code === '+1' || /united states|usa/i.test(candProfile?.country || '');
              const isIndia = !isUs && (isYaswanth || candProfile?.country_code === '+91' || /india/i.test(candProfile?.country || ''));

              if (isUs || isIndia) {
                const targetCountryCode = isUs ? 'us' : 'in';

                // 1. Try intl-tel-input JavaScript instance
                await found.locator.evaluate((el: HTMLInputElement, code: string) => {
                  try {
                    const iti = (window as any).intlTelInputGlobals?.getInstance?.(el) || (el as any).iti;
                    if (iti && typeof iti.setCountry === 'function') {
                      iti.setCountry(code);
                      return true;
                    }
                    if (typeof (window as any).$ !== 'undefined') {
                      const $ = (window as any).$;
                      if (typeof $(el).intlTelInput === 'function') {
                        $(el).intlTelInput('setCountry', code);
                        return true;
                      }
                    }
                  } catch {}
                  return false;
                }, targetCountryCode).catch(() => {});

                // 2. Try UI dropdown interaction if flag/country is visible
                const itiContainer = found.locator.locator('xpath=ancestor::*[contains(@class, "iti")][1]');
                const flagBtn = (await itiContainer.count()) > 0
                  ? itiContainer.locator('.iti__selected-country, .iti__selected-flag, .iti__flag-container [role="combobox"]').first()
                  : page.locator('.iti__selected-country, .iti__selected-flag, .iti__flag-container [role="combobox"]').first();

                if ((await flagBtn.count()) > 0 && (await flagBtn.isVisible())) {
                  const titleText = (await flagBtn.getAttribute('title').catch(() => '')) || '';
                  const ariaLabel = (await flagBtn.getAttribute('aria-label').catch(() => '')) || '';
                  const btnText = (await flagBtn.innerText().catch(() => '')) || '';
                  const combinedStatus = `${titleText} ${ariaLabel} ${btnText}`.toLowerCase();

                  const alreadyMatches = isUs
                    ? (combinedStatus.includes('united states') || combinedStatus.includes('+1'))
                    : (combinedStatus.includes('india') || combinedStatus.includes('+91'));

                  if (!alreadyMatches) {
                    console.log(`[Form Filler] 📞 Setting intl-tel-input country to ${isUs ? 'United States (+1)' : 'India (+91)'}`);
                    await flagBtn.click({ timeout: 2000 }).catch(() => {});
                    await page.waitForTimeout(200);

                    const countryItem = page.locator(
                      `li.iti__country[data-country-code="${targetCountryCode}"], ` +
                      `li.iti__country[data-dial-code="${isUs ? '1' : '91'}"], ` +
                      `li.iti__country:has-text("${isUs ? 'United States' : 'India'}")`
                    ).first();

                    if ((await countryItem.count()) > 0) {
                      await countryItem.scrollIntoViewIfNeeded().catch(() => {});
                      await countryItem.click({ timeout: 2000 }).catch(() => {});
                      await page.waitForTimeout(200);
                    } else {
                      await page.keyboard.press('Escape').catch(() => {});
                    }
                  }
                }
              }
            } catch (itiErr: any) {
              console.warn(`[Form Filler] ⚠️ intl-tel-input notice: ${itiErr.message}`);
            }
          }
        }
      } else {
        throw new Error(`Text or dropdown element not found for ${name} (${label})`);
      }
    }
  } catch (fieldErr: any) {
    fillResult.success = false;
    fillResult.error = fieldErr.message;
    console.warn(`[Form Filler] ⚠️ Could not populate field "${label}" (${name}): ${fieldErr.message}`);
  }

  return fillResult;
}

/**
 * Fills all resolved form fields into the active Greenhouse page DOM,
 * with dynamic cascade detection loops for conditionally revealed fields.
 *
 * @param page - Active Playwright Page instance
 * @param application - Application record containing resolved fields and candidate ID
 * @param options - Configuration overrides for jitter, timeouts, and cascading cycles
 * @returns Summary of filled and failed fields
 */
export async function fillForm(
  page: Page,
  application: CandidateJobApplication | ApplicationRow,
  options: FormFillerOptions = {}
): Promise<FormFillSummary> {
  const minJitterMs = options.minJitterMs ?? 300;
  const maxJitterMs = options.maxJitterMs ?? 800;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxCascadeCycles = options.maxCascadeCycles ?? 3;
  const maxCascadeTimeoutMs = options.maxCascadeTimeoutMs ?? 2000;

  const appObj = application as any;
  const applywizzId: string = appObj.applywizz_id || appObj.applywizzId || '';
  const appId: string = appObj.id || applywizzId || 'unknown-app';
  const jobUrl: string = appObj.job_url || appObj.jobUrl || page.url();

  // Normalize resolved fields array
  const rawFields = appObj.resolved_fields || appObj.resolvedFields || [];
  const fields: ResolvedField[] = Array.isArray(rawFields) ? [...rawFields] : [];

  console.log(
    `[Form Filler] 📝 Populating ${fields.length} initial resolved fields for candidate ${applywizzId} on ${jobUrl}...`
  );

  const results: FieldFillResult[] = [];
  const tempFilesToClean: string[] = [];

  try {
    // 1. Ensure form exists on page
    await page.waitForSelector('form#application_form, form#app_form, form', {
      timeout: timeoutMs,
    }).catch(() => {
      console.warn('[Form Filler] ⚠️ Form element not found immediately, proceeding with page-wide selectors.');
    });

    // 2. Populate initial queue of resolved fields
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const fillRes = await fillSingleField(page, field, applywizzId, tempFilesToClean, options);
      results.push(fillRes);

      // Apply human-like randomized jitter before next field
      if (i + 1 < fields.length && maxJitterMs > 0) {
        await sleepRandomJitter(minJitterMs, maxJitterMs);
      }
    }

    // 3. Dynamic Cascade Loop for Conditionally Revealed Fields
    let cascadeCycle = 0;
    const cascadeStartTime = Date.now();

    // Lazy-loaded resolution context
    let resolver: AnswerResolver | null = null;
    let profile: ProfileRow | null = null;
    let parsedResume: ResumeParsedRow | null = null;
    let qaEntries: QABankRow[] | undefined = undefined;

    while (cascadeCycle < maxCascadeCycles && Date.now() - cascadeStartTime < maxCascadeTimeoutMs) {
      cascadeCycle++;
      // Wait 500ms for potential DOM mutations triggered by previous selections
      await page.waitForTimeout(500);

      const knownFieldIds = new Set(results.map((r) => r.fieldId));
      const knownNames = new Set(results.map((r) => r.name).filter(Boolean));

      const unmappedFields = await getUnmappedVisibleFields(page, knownFieldIds, knownNames);
      if (unmappedFields.length === 0) {
        break; // No new unmapped visible fields
      }

      console.log(
        `[Form Filler] 🔄 Cascade Cycle ${cascadeCycle}: Detected ${unmappedFields.length} newly visible unmapped field(s)...`
      );

      // Initialize resolution context if not yet done
      if (!resolver) {
        resolver = new AnswerResolver();
        profile = await getProfile(applywizzId);
        parsedResume = await getOrParseResume(applywizzId);
        qaEntries = await findAnswersByCandidate(applywizzId);
      }

      for (const unmappedField of unmappedFields) {
        // Resolve field on the fly via 5-tier waterfall
        const resolved = await resolver.resolveField(applywizzId, unmappedField, {
          profile,
          parsedResume,
          qaEntries,
          jobContext: {
            companyName: appObj.company_name || appObj.companyName || '',
            jobTitle: appObj.job_title || appObj.jobTitle || '',
          },
        });

        console.log(
          `[Form Filler] 💡 Resolved dynamic field "${resolved.label}" (${resolved.fieldId}) -> "${resolved.value}" [Tier ${resolved.resolvedByTier ?? 'None'}]`
        );

        // Fill the newly resolved field
        const fillRes = await fillSingleField(page, resolved, applywizzId, tempFilesToClean, options);
        results.push(fillRes);

        // Keep application resolved_fields updated
        if (Array.isArray(appObj.resolved_fields)) {
          appObj.resolved_fields.push(resolved);
        } else if (Array.isArray(appObj.resolvedFields)) {
          appObj.resolvedFields.push(resolved);
        }

        // Apply human jitter between cascading fields
        if (maxJitterMs > 0) {
          await sleepRandomJitter(minJitterMs, maxJitterMs);
        }
      }
    }

    // 4. Standard Fields Safety Sweep (Ensure First Name, Last Name, Email, Phone are populated)
    try {
      if (!profile && applywizzId) {
        profile = await getProfile(applywizzId);
      }
      if (!parsedResume && applywizzId) {
        parsedResume = await getOrParseResume(applywizzId);
      }

      // 4a. Check First Name
      const firstNameLoc = page.locator('#first_name, input[name="first_name"], input[name="job_application[first_name]"], input[autocomplete="given-name"]').first();
      if ((await firstNameLoc.count()) > 0 && (await firstNameLoc.isVisible())) {
        const currentVal = await firstNameLoc.inputValue().catch(() => '');
        if (!currentVal || currentVal.trim() === '') {
          let fName = profile?.first_name || '';
          if (!fName && profile?.client_name && !profile.client_name.startsWith('AWL-')) {
            fName = profile.client_name.trim().split(/\s+/)[0];
          }
          if (!fName && parsedResume?.raw_text) {
            const firstLine = parsedResume.raw_text.split('\n')[0].trim();
            fName = firstLine.split(/\s+/)[0];
          }
          if (fName) {
            console.log(`[Form Filler] 🛡️ Safety Sweep: Populating empty First Name with "${fName}"`);
            await firstNameLoc.fill(fName);
            await firstNameLoc.evaluate((el: HTMLInputElement) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
            results.push({
              fieldId: 'first_name',
              name: 'first_name',
              type: 'text',
              label: 'First Name',
              valuePopulated: fName,
              success: true,
            });
          }
        }
      }

      // 4b. Check Last Name
      const lastNameLoc = page.locator('#last_name, input[name="last_name"], input[name="job_application[last_name]"], input[autocomplete="family-name"]').first();
      if ((await lastNameLoc.count()) > 0 && (await lastNameLoc.isVisible())) {
        const currentVal = await lastNameLoc.inputValue().catch(() => '');
        if (!currentVal || currentVal.trim() === '') {
          let lName = profile?.last_name || '';
          if (!lName && profile?.client_name && !profile.client_name.startsWith('AWL-')) {
            const parts = profile.client_name.trim().split(/\s+/);
            lName = parts.slice(1).join(' ') || parts[0];
          }
          if (!lName && parsedResume?.raw_text) {
            const firstLine = parsedResume.raw_text.split('\n')[0].trim();
            const parts = firstLine.split(/\s+/);
            lName = parts.slice(1).join(' ') || parts[0];
          }
          if (lName) {
            console.log(`[Form Filler] 🛡️ Safety Sweep: Populating empty Last Name with "${lName}"`);
            await lastNameLoc.fill(lName);
            await lastNameLoc.evaluate((el: HTMLInputElement) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
            results.push({
              fieldId: 'last_name',
              name: 'last_name',
              type: 'text',
              label: 'Last Name',
              valuePopulated: lName,
              success: true,
            });
          }
        }
      }

      // 4c. Check Email
      const emailLoc = page.locator('#email, input#email, input[name="email"], input[name="job_application[email]"], input[type="email"], input[autocomplete="email"]').first();
      if ((await emailLoc.count()) > 0 && (await emailLoc.isVisible())) {
        const currentVal = await emailLoc.inputValue().catch(() => '');
        if (!currentVal || currentVal.trim() === '') {
          const compEmail = (profile?.company_email && profile.company_email.trim().length > 0)
            ? profile.company_email.trim()
            : (profile ? getCompanyEmail(profile) : null);
          if (compEmail) {
            console.log(`[Form Filler] 🛡️ Safety Sweep: Populating empty Email with company email "${compEmail}"`);
            await emailLoc.fill(compEmail);
            await emailLoc.evaluate((el: HTMLInputElement) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
            console.log(`[Form Filler] 📧 Email field filled with company email: ${compEmail} (source: company_email)`);
            results.push({
              fieldId: 'email',
              name: 'email',
              type: 'text',
              label: 'Email',
              valuePopulated: compEmail,
              success: true,
            });
          }
        }
      }

      // 4d. Check Phone
      const phoneLoc = page.locator('#phone, input#phone, input[name="phone"], input[name="job_application[phone]"], input[type="tel"]').first();
      if ((await phoneLoc.count()) > 0 && (await phoneLoc.isVisible())) {
        const currentVal = await phoneLoc.inputValue().catch(() => '');
        if (!currentVal || currentVal.trim() === '') {
          let phoneVal = profile?.phone || '';
          if (phoneVal) {
            phoneVal = phoneVal.replace(/^\+?1[\s.-]*/, '').replace(/^\+/, '').replace(/\s+/g, ' ').trim();
            console.log(`[Form Filler] 🛡️ Safety Sweep: Populating empty Phone with "${phoneVal}"`);
            await phoneLoc.fill(phoneVal);
            await phoneLoc.evaluate((el: HTMLInputElement) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
            results.push({
              fieldId: 'phone',
              name: 'phone',
              type: 'text',
              label: 'Phone',
              valuePopulated: phoneVal,
              success: true,
            });
          }
        }
      }
    } catch (sweepErr: any) {
      console.warn(`[Form Filler] ⚠️ Safety sweep notice: ${sweepErr.message}`);
    }
  } finally {
    // Guaranteed cleanup of downloaded temporary resume PDFs
    for (const tempPath of tempFilesToClean) {
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
          console.log(`[Form Filler] 🧹 Cleaned up temporary resume file: ${tempPath}`);
        }
      } catch (cleanErr: any) {
        console.warn(`[Form Filler] ⚠️ Failed to unlink temp file ${tempPath}: ${cleanErr.message}`);
      }
    }
  }

  const filledFields = results.filter((r) => r.success).length;
  const failedFields = results.filter((r) => !r.success).length;

  console.log(
    `[Form Filler] 🏁 Finished filling form: ${filledFields}/${results.length} successful, ${failedFields} failed.`
  );

  return {
    applicationId: appId,
    jobUrl,
    totalFields: results.length,
    filledFields,
    failedFields,
    results,
  };
}

export default fillForm;
