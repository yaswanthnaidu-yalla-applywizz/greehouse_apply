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
import { getProfile, type ProfileRow } from '../db/profiles.js';
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
  const val = (field.value ?? '').trim();
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

  // Skip empty non-required fields if no value provided
  if (!val && rawType !== 'file') {
    fillResult.success = true;
    return fillResult;
  }

  try {
    if (rawType === 'file' || fieldId === 'resume' || name.toLowerCase().includes('resume')) {
      // ==========================================
      // File Upload (Master Resume PDF)
      // ==========================================
      const fileSelectors = [
        (field as any).metadata?.selector,
        `input[type="file"]#${escapeId(name)}`,
        `input[type="file"]#${escapeId(fieldId)}`,
        'input[type="file"]#resume',
        'input[type="file"][name*="resume"]',
        '#resume_file',
        'input[type="file"]',
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
      // Select Dropdown (Native & React-Select)
      // ==========================================
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
        await page.waitForTimeout(600);
        found = await findElementLocator(page, selectSelectors, timeoutMs);
      }

      if (found) {
        const tagName = await found.locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'SELECT');

        if (tagName === 'INPUT' || tagName === 'DIV' || tagName === 'BUTTON') {
          // Modern React-Select combobox input
          await found.locator.scrollIntoViewIfNeeded().catch(() => {});
          await found.locator.click().catch(() => {});
          await page.waitForTimeout(150);
          await found.locator.pressSequentially(val, { delay: 35 });
          await page.waitForTimeout(350);

          const escapedVal = val.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const exactOpt = page.locator('.select__option, [id*="-option"], [role="option"]').filter({
            hasText: new RegExp(`^${escapedVal}$`, 'i'),
          }).first();

          if ((await exactOpt.count()) > 0) {
            await exactOpt.click({ timeout: 2000 }).catch(() => {});
          } else {
            const fuzzyOpt = page.locator('.select__option, [id*="-option"], [role="option"]').filter({
              hasText: new RegExp(escapedVal, 'i'),
            }).first();
            if ((await fuzzyOpt.count()) > 0) {
              await fuzzyOpt.click({ timeout: 2000 }).catch(() => {});
            } else {
              await page.keyboard.press('Tab').catch(() => {});
            }
          }

          // If this was hispanic_ethnicity, give DOM time to render conditional race field
          if (fieldId.includes('hispanic') || name.includes('hispanic')) {
            await page.waitForTimeout(500);
          }

          fillResult.success = true;
        } else {
          // Native HTML <select>
          let selected = false;
          // 1. Try exact label match
          try {
            await found.locator.selectOption({ label: val }, { timeout: 2000 });
            selected = true;
          } catch {}

          // 2. Try value match
          if (!selected) {
            try {
              await found.locator.selectOption({ value: val }, { timeout: 2000 });
              selected = true;
            } catch {}
          }

          // 3. Try fuzzy/case-insensitive option match
          if (!selected) {
            try {
              const optionsList = await found.locator.locator('option').allInnerTexts();
              const lowerVal = val.toLowerCase().trim();
              const matchedOpt = optionsList.find((opt) => {
                const o = opt.toLowerCase().trim();
                return o === lowerVal || o.includes(lowerVal) || lowerVal.includes(o);
              });
              if (matchedOpt) {
                await found.locator.selectOption({ label: matchedOpt.trim() }, { timeout: 2000 });
                selected = true;
              }
            } catch {}
          }

          if (selected) {
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
          const optLoc = page.locator(`.select2-results__option, [role="option"]`).filter({ hasText: val }).first();
          const optCount = await optLoc.count();
          if (optCount > 0) {
            await optLoc.click();
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
            await radio.check({ force: true });
            checked = true;
            break;
          }
        }
      }

      if (!checked) {
        const labelLoc = page.locator('label').filter({ hasText: val }).first();
        if ((await labelLoc.count()) > 0) {
          await labelLoc.click({ force: true });
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
      const isAffirmative = ['true', '1', 'yes', 'y', 'checked', 'agree'].includes(val.toLowerCase());
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
          await found.locator.check({ force: true });
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
      // Default: Standard Text Input
      // ==========================================
      const textSelectors = [
        (field as any).metadata?.selector,
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
        `input[id*="${escapeAttr(name)}"]`,
      ].filter(Boolean);

      const found = await findElementLocator(page, textSelectors, timeoutMs);
      if (found) {
        await found.locator.scrollIntoViewIfNeeded().catch(() => {});
        await found.locator.click().catch(() => {});
        await found.locator.fill(val, { timeout: timeoutMs });
        await found.locator.evaluate((el: HTMLInputElement) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }).catch(() => {});
        fillResult.success = true;
      } else {
        const labelLoc = page.locator(`label:has-text("${label}")`).first();
        if ((await labelLoc.count()) > 0) {
          const inputLoc = labelLoc.locator('..').locator('input').first();
          if ((await inputLoc.count()) > 0) {
            await inputLoc.scrollIntoViewIfNeeded().catch(() => {});
            await inputLoc.click().catch(() => {});
            await inputLoc.fill(val, { timeout: timeoutMs });
            await inputLoc.evaluate((el: HTMLInputElement) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
            fillResult.success = true;
          } else {
            throw new Error(`Text input element not found for ${name} (${label})`);
          }
        } else {
          throw new Error(`Text input element not found for ${name} (${label})`);
        }
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
