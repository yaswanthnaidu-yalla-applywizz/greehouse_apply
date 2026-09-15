/**
 * @fileoverview Playwright Form Filler Engine with Cascading Field Detection (Phase V2-4b).
 *
 * Automatically populates resolved candidate answers into Greenhouse job application forms
 * with resilient DOM selector fallback hierarchies, randomized 300-800ms human-like jitter,
 * robust resume temporary file management with guaranteed cleanup, and dynamic cascade
 * detection loops for conditionally revealed fields (e.g. Hispanic/Latino -> Race).
 */

import fs from 'fs';
import path from 'path';
import type { Page, Locator } from 'playwright';
import { downloadResumeTempFile, isDemoResumeApplywizzId } from '../db/storage.js';
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

const CUSTOM_SELECT_OPTION_LOCATOR =
  '.select__option:not(.iti__country), [id*="-option"]:not(.iti__country), [role="option"]:not(.iti__country), .select2-results__option:not(.iti__country), [role="listbox"] [role="option"]:not(.iti__country), [class*="menu"] [role="option"]:not(.iti__country)';

/** Greenhouse job-board remix-css searchable selects (not a native select element). */
const GREENHOUSE_SELECT_INPUT_CONTAINER =
  '[class*="select_input-container"], .select_input-container';

type OptionTextMatcher = (optionText: string, answerText: string) => boolean;

function exactOptionTextMatch(optionText: string, answerText: string): boolean {
  const opt = optionText.trim();
  const ans = answerText.trim();
  return opt === ans || opt.toLowerCase() === ans.toLowerCase();
}

function fuzzyOptionTextMatch(optionText: string, answerText: string): boolean {
  if (exactOptionTextMatch(optionText, answerText)) return true;
  const opt = optionText.trim().toLowerCase();
  const ans = answerText.trim().toLowerCase();
  if (!opt || !ans) return false;
  if (opt.startsWith(ans) || ans.startsWith(opt)) return true;
  if (ans === 'yes' && /^yes\b/.test(opt)) return true;
  if (ans === 'no' && /^no\b/.test(opt)) return true;
  return opt.includes(ans) || ans.includes(opt);
}

async function isUsableNativeSelect(locator: Locator): Promise<boolean> {
  const tagName = await locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => '');
  if (tagName !== 'SELECT') return false;
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  const optionCount = await locator.locator('option').count().catch(() => 0);
  return optionCount > 1;
}

async function isInteractiveSelectControl(locator: Locator): Promise<boolean> {
  const tagName = await locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => '');
  const role = (await locator.getAttribute('role').catch(() => '')) || '';
  const className = (await locator.getAttribute('class').catch(() => '')) || '';
  const ariaCombobox = (await locator.getAttribute('aria-combobox').catch(() => '')) || '';
  if (tagName === 'INPUT' && (role === 'combobox' || className.includes('select__input'))) return true;
  if (role === 'combobox' || ariaCombobox === 'true') return true;
  if (className.includes('select__input') || className.includes('select__control')) return true;
  const nestedCombobox = locator.locator(
    `input[role="combobox"], input[aria-combobox="true"], .select__input, ${GREENHOUSE_SELECT_INPUT_CONTAINER} input`
  );
  return (await nestedCombobox.count().catch(() => 0)) > 0;
}

/**
 * Finds Greenhouse remix-css / React-Select combobox inputs when no native select is usable.
 */
async function findSearchableSelectControl(
  page: Page,
  fieldId: string,
  name: string,
  label: string,
  metadataSelector?: string
): Promise<{ locator: Locator; selector: string } | null> {
  const ids = Array.from(new Set([name, fieldId].filter(Boolean)));
  const candidates: string[] = [];

  if (metadataSelector && !/^select#/i.test(metadataSelector.trim())) {
    candidates.push(metadataSelector.trim());
  }

  for (const id of ids) {
    candidates.push(
      `#${escapeId(id)}`,
      `${GREENHOUSE_SELECT_INPUT_CONTAINER} input#${escapeId(id)}`,
      `${GREENHOUSE_SELECT_INPUT_CONTAINER} input[id="${escapeAttr(id)}"]`,
      `input[role="combobox"]#${escapeId(id)}`,
      `input[role="combobox"][id="${escapeAttr(id)}"]`,
      `[aria-combobox="true"]#${escapeId(id)}`,
      `input[id="${escapeAttr(id)}"][role="combobox"]`
    );
  }

  candidates.push(
    `input[role="combobox"][id*="${escapeAttr(name)}"]`,
    `input[role="combobox"][id*="${escapeAttr(fieldId)}"]`,
    `[role="combobox"][id*="${escapeAttr(name)}"]`,
    `[aria-combobox="true"]`
  );

  const fromSelectors = await findElementLocator(page, candidates);
  if (fromSelectors && (await isInteractiveSelectControl(fromSelectors.locator))) {
    return fromSelectors;
  }

  if (label) {
    const labelLoc = page.locator(`label:has-text("${label}")`).first();
    if ((await labelLoc.count()) > 0) {
      const fieldRoot = labelLoc.locator(
        `xpath=ancestor::*[contains(@class,"field") or contains(@class,"question")][1]`
      ).first();
      const searchRoot = (await fieldRoot.count()) > 0 ? fieldRoot : labelLoc.locator('..').first();
      const containerInput = searchRoot.locator(
        `${GREENHOUSE_SELECT_INPUT_CONTAINER} input[type="text"], ${GREENHOUSE_SELECT_INPUT_CONTAINER} input[role="combobox"], input[role="combobox"], input[aria-combobox="true"], .select__input`
      ).first();
      if ((await containerInput.count()) > 0) {
        return { locator: containerInput, selector: `label("${label}") → searchable select input` };
      }
    }
  }

  return null;
}

/**
 * Resolves the type-ahead input (if any) and click target for React-Select / combobox controls.
 */
async function resolveComboboxControls(
  control: Locator
): Promise<{ searchInput: Locator | null; openTrigger: Locator }> {
  const tagName = await control.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => '');
  const role = await control.getAttribute('role').catch(() => null);
  const className = (await control.getAttribute('class').catch(() => '')) || '';

  const nestedInput = control.locator('input[type="text"], input:not([type="hidden"]), .select__input').first();
  if (tagName === 'INPUT' || className.includes('select__input') || role === 'combobox') {
    return { searchInput: control, openTrigger: control };
  }
  if ((await nestedInput.count()) > 0) {
    return { searchInput: nestedInput, openTrigger: control };
  }

  const container = control.locator(
    'xpath=ancestor-or-self::*[contains(@class,"select_input-container") or contains(@class,"select__control") or contains(@class,"select-shell") or contains(@class,"css-control")][1]'
  ).first();
  if ((await container.count()) > 0) {
    const containerInput = container.locator('input[type="text"], input[role="combobox"], .select__input').first();
    if ((await containerInput.count()) > 0) {
      return { searchInput: containerInput, openTrigger: container };
    }
    return { searchInput: null, openTrigger: container };
  }

  return { searchInput: null, openTrigger: control };
}

async function comboboxDisplaysAnswer(
  control: Locator,
  answerText: string,
  matchOption: OptionTextMatcher = fuzzyOptionTextMatch
): Promise<boolean> {
  const controlRoot = control
    .locator('xpath=ancestor::div[contains(@class,"select__control")][1]')
    .first();
  if ((await controlRoot.count()) > 0) {
    const single = (await controlRoot.locator('.select__single-value').innerText().catch(() => '')).trim();
    if (single && matchOption(single, answerText)) return true;
  }
  const inputVal = (await control.inputValue().catch(() => '')).trim();
  return Boolean(inputVal && matchOption(inputVal, answerText));
}

async function resolveSelectOptionScope(control: Locator): Promise<Locator | null> {
  const fieldWrapper = control
    .locator('xpath=ancestor::*[contains(@class,"field-wrapper")][1]')
    .first();
  if ((await fieldWrapper.count()) > 0) return fieldWrapper;
  const shell = control
    .locator('xpath=ancestor::*[contains(@class,"select-shell")][1]')
    .first();
  if ((await shell.count()) > 0) return shell;
  return null;
}

async function clickDropdownOptionByMatch(
  page: Page,
  answerText: string,
  matchOption: OptionTextMatcher,
  scope?: Locator | null
): Promise<boolean> {
  const roots: Locator[] = [];
  if (scope && (await scope.count()) > 0) roots.push(scope);
  roots.push(page.locator('body'));

  for (const root of roots) {
    const options = root.locator(CUSTOM_SELECT_OPTION_LOCATOR);
    const count = await options.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const opt = options.nth(i);
      const visible = await opt.isVisible().catch(() => false);
      if (!visible) continue;
      const text = (await opt.innerText().catch(() => '')).trim();
      if (!text) continue;
      if (matchOption(text, answerText)) {
        await opt.scrollIntoViewIfNeeded().catch(() => {});
        await opt.click({ force: true, timeout: 2500 });
        return true;
      }
    }
  }
  return false;
}

/**
 * Searchable/combobox select: type into filter input when present, else open menu; then click option by text match.
 */
async function fillInteractiveSelectDropdown(
  page: Page,
  control: Locator,
  answerText: string,
  matchOption: OptionTextMatcher = exactOptionTextMatch
): Promise<boolean> {
  await control.scrollIntoViewIfNeeded().catch(() => {});
  const { searchInput, openTrigger } = await resolveComboboxControls(control);

  if (searchInput) {
    const sameOpenAndSearch = openTrigger === searchInput;
    if (!sameOpenAndSearch) {
      await openTrigger.click({ force: true }).catch(() => {});
    }
    await searchInput.click({ force: true }).catch(() => {});
    await searchInput.fill('').catch(() => {});
    await searchInput.pressSequentially(answerText, { delay: 35 });
    await page.waitForTimeout(500);
  } else {
    await openTrigger.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const optionScope = await resolveSelectOptionScope(control);
  let clicked = await clickDropdownOptionByMatch(page, answerText, matchOption, optionScope);
  if (!clicked) {
    clicked = await clickDropdownOptionByMatch(page, answerText, fuzzyOptionTextMatch, optionScope);
  }
  if (!clicked && searchInput) {
    await searchInput.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(150);
    clicked = await clickDropdownOptionByMatch(page, answerText, fuzzyOptionTextMatch, optionScope);
  }

  if (!clicked && optionScope) {
    const toggle = optionScope
      .locator('button[aria-label*="Toggle"], button.icon-button[aria-label*="flyout"]')
      .first();
    if ((await toggle.count()) > 0) {
      await toggle.click({ force: true }).catch(() => {});
      await page.waitForTimeout(350);
      clicked = await clickDropdownOptionByMatch(page, answerText, fuzzyOptionTextMatch, optionScope);
      if (!clicked) {
        clicked = await clickDropdownOptionByMatch(
          page,
          answerText,
          fuzzyOptionTextMatch,
          page.locator('body')
        );
      }
    }
  }

  if (clicked && searchInput) {
    const inputTag = await searchInput
      .evaluate((el: HTMLElement) => el.tagName.toUpperCase())
      .catch(() => '');
    if (inputTag === 'INPUT') {
      clicked = await comboboxDisplaysAnswer(searchInput, answerText, matchOption);
    }
  }

  return clicked;
}

async function fillSearchableSelectInput(
  page: Page,
  control: Locator,
  selector: string,
  answerText: string,
  matchOption: OptionTextMatcher = exactOptionTextMatch
): Promise<boolean> {
  const selected = await fillInteractiveSelectDropdown(page, control, answerText, matchOption);
  if (selected) {
    console.log(
      `[Submitter] Populated via searchable select input → selector: ${selector} → value: ${answerText}`
    );
  }
  return selected;
}

function normalizeBooleanValue(value: string): 'Yes' | 'No' | null {
  const normalized = value.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'agree', 'checked'].includes(normalized)) return 'Yes';
  if (['no', 'n', 'false', '0', 'disagree', 'unchecked'].includes(normalized)) return 'No';
  return null;
}

export function isCountryCodeField(fieldId: string, name: string, label: string): boolean {
  const combined = `${fieldId} ${name} ${label}`.toLowerCase();
  if (/sponsorship|visa|relocat|citizen/i.test(combined)) return false;
  return (
    fieldId === 'country' ||
    name === 'country' ||
    fieldId === 'country_code' ||
    name === 'country_code' ||
    /country\s*code|phone\s*country/i.test(combined) ||
    (combined.includes('country') && !/salary|relocation/i.test(combined))
  );
}

export function isSponsorshipQuestion(fieldId: string, name: string, label: string): boolean {
  const combined = `${fieldId} ${name} ${label}`.toLowerCase();
  return /sponsorship|visa|require.*sponsorship|employer-based visa/i.test(combined);
}

/** DEBUG (sponsorship dry-run): print every input on the page with its id and role. */
async function debugDumpPageInputs(page: Page): Promise<void> {
  const inputs = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('input')).map((el) => ({
        id: el.id || '(no id)',
        role: el.getAttribute('role') || '(no role)',
        type: el.type,
        ariaExpanded: el.getAttribute('aria-expanded'),
        cls: (el.className || '').toString().slice(0, 60),
      }))
    )
    .catch(() => [] as Array<{ id: string; role: string; type: string; ariaExpanded: string | null; cls: string }>);
  console.log(`[Sponsorship DEBUG] ${inputs.length} input elements on page:`);
  for (const i of inputs) {
    console.log(
      `  - id=${i.id} role=${i.role} type=${i.type} aria-expanded=${i.ariaExpanded} class=${i.cls}`
    );
  }
}

/**
 * DEBUG fallback (sponsorship): exact sequence — page.locator('[role="combobox"]'),
 * match by nearest label text containing "sponsor" when multiple, click → type answer →
 * wait for [role="option"] → click matching option.
 */
async function debugSponsorshipComboboxSequence(page: Page, answerText: string): Promise<boolean> {
  const comboboxes = page.locator('[role="combobox"]');
  const count = await comboboxes.count().catch(() => 0);
  console.log(`[Sponsorship DEBUG] Found ${count} [role="combobox"] element(s) on page`);
  if (count === 0) return false;

  let target = comboboxes.first();
  if (count > 1) {
    for (let i = 0; i < count; i++) {
      const cb = comboboxes.nth(i);
      const labelText = await cb
        .evaluate((el: HTMLElement) => {
          const root =
            el.closest('.field-wrapper') || el.closest('label') || el.parentElement?.parentElement;
          return (root?.textContent || '').trim();
        })
        .catch(() => '');
      console.log(`[Sponsorship DEBUG] combobox[${i}] nearest label text: "${labelText.slice(0, 100)}"`);
      if (/sponsor/i.test(labelText)) {
        target = cb;
        console.log(`[Sponsorship DEBUG] → selected combobox[${i}] (label contains "sponsor")`);
        break;
      }
    }
  }

  const targetId = await target.getAttribute('id').catch(() => null);
  console.log(`[Sponsorship DEBUG] Attempting sequence on combobox id=${targetId ?? '(none)'}`);
  await target.click({ timeout: 3000 }).catch((e) => {
    console.log(`[Sponsorship DEBUG] click failed: ${e.message}`);
  });
  await target.pressSequentially(answerText, { delay: 40 }).catch((e) => {
    console.log(`[Sponsorship DEBUG] type failed: ${e.message}`);
  });

  const option = page
    .locator('[role="option"]', { hasText: new RegExp(`^${answerText}\\b`, 'i') })
    .first();
  try {
    await option.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    const visibleOptions = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
    console.log(
      `[Sponsorship DEBUG] No [role="option"] matching "${answerText}" appeared; options seen: ${JSON.stringify(visibleOptions)}`
    );
    return false;
  }
  const optText = (await option.innerText().catch(() => '')).trim();
  await option.click({ timeout: 3000 });
  console.log(`[Sponsorship DEBUG] Clicked option "${optText}" ✅`);
  return true;
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
  const isCountryCode = isCountryCodeField(fieldId, name, label);
  const isSponsorship = isSponsorshipQuestion(fieldId, name, label);

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
          if (isDemoResumeApplywizzId(applywizzId)) {
            const localCandidates = [
              path.resolve(process.cwd(), 'resumes', `${applywizzId}_resume.pdf`),
              path.resolve(process.cwd(), 'resumes', 'AWL-YASHANTH_resume.pdf'),
              path.resolve(process.cwd(), 'resumes', 'my-resume.pdf'),
            ];
            const foundLocal = localCandidates.find((p) => fs.existsSync(p));
            if (foundLocal) {
              tempResumePath = foundLocal;
            } else {
              throw new Error(`Could not obtain resume PDF: ${dlErr.message}`);
            }
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
      let selectValue = booleanValue || val;

      // Special resolution for country code dropdown (phone country) - strictly +1 (United States)
      let targetCountryName = 'United States';
      let targetDialCode = '+1';
      if (isCountryCode) {
        selectValue = targetCountryName;
      }

      // Check for sponsorship question rendered as radio buttons in the DOM
      if (isSponsorship) {
        const sponsorshipRadios = page.locator(
          `input[type="radio"][name="${escapeAttr(name)}"], input[type="radio"][name="${escapeAttr(fieldId)}"], input[type="radio"][name*="sponsorship"], input[type="radio"][name*="visa"]`
        );
        const radioCount = await sponsorshipRadios.count().catch(() => 0);
        if (radioCount > 0) {
          let radioClicked = false;
          let radioSelectorUsed = '';
          for (let r = 0; r < radioCount; r++) {
            const radio = sponsorshipRadios.nth(r);
            const rVal = (await radio.getAttribute('value').catch(() => '')) || '';
            const rId = (await radio.getAttribute('id').catch(() => '')) || '';
            let rText = '';
            if (rId) {
              const lLoc = page.locator(`label[for="${escapeId(rId)}"]`).first();
              if ((await lLoc.count()) > 0) rText = (await lLoc.innerText().catch(() => '')) || '';
            }
            if (!rText) {
              const parentL = radio.locator('..').first();
              if ((await parentL.count()) > 0) rText = (await parentL.innerText().catch(() => '')) || '';
            }
            if (/^yes\b/i.test(rText.trim()) || /^yes\b/i.test(rVal.trim()) || ['true', '1'].includes(rVal.trim().toLowerCase())) {
              radioSelectorUsed = rId ? `#${rId}` : `input[type="radio"][name="${escapeAttr(name)}"][value="${rVal}"]`;
              await radio.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
              await radio.click({ force: true, timeout: 3000 });
              radioClicked = true;
              break;
            }
          }
          if (radioClicked) {
            fillResult.success = true;
            console.log(
              `[Submitter] Sponsorship field → selector: ${radioSelectorUsed || 'radio[name=' + name + ']'} → attempted click: Yes → result: selected`
            );
            return fillResult;
          }
        }
      }

      const selectSelectors = [
        (field as any).metadata?.selector,
        ...(isCountryCode ? [
          '#country',
          'input#country',
          'select#country',
          'select[name="country"]',
          'select#job_application_country',
          'select[name="job_application[country]"]',
          '#phone_country_code',
          'select[name*="phone_country"]',
          'select[name*="country_code"]',
          '[data-testid="country-dropdown"]',
        ] : []),
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

      if (isSponsorship) {
        await debugDumpPageInputs(page);
        console.log(
          `[Sponsorship DEBUG] Question: "${label}" → attempting selectors: ${JSON.stringify(selectSelectors)}`
        );
      }

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
          const candidateSelect = parent.locator(
            `select, ${GREENHOUSE_SELECT_INPUT_CONTAINER} input, input[role="combobox"], input[aria-combobox="true"], .select__input, .select2-selection`
          ).first();
          if ((await candidateSelect.count()) > 0) {
            found = { locator: candidateSelect, selector: `label("${label}") -> dropdown` };
          }
        }
      }

      // Hidden/disabled native <select> while remix-css combobox input is the real control
      if (found && !(await isUsableNativeSelect(found.locator))) {
        const nativeTag = await found.locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => '');
        if (nativeTag === 'SELECT') {
          const searchable = await findSearchableSelectControl(
            page,
            fieldId,
            name,
            label,
            (field as any).metadata?.selector
          );
          if (searchable) {
            found = searchable;
          } else {
            found = null;
          }
        }
      }

      if (!found) {
        const searchable = await findSearchableSelectControl(
          page,
          fieldId,
          name,
          label,
          (field as any).metadata?.selector
        );
        if (searchable) {
          found = searchable;
        }
      }

      if (found) {
        const tagName = await found.locator.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'SELECT');
        const role = await found.locator.getAttribute('role').catch(() => null);
        const className = (await found.locator.getAttribute('class').catch(() => '')) || '';
        const interactive =
          (await isInteractiveSelectControl(found.locator)) ||
          tagName === 'INPUT' ||
          tagName === 'DIV' ||
          tagName === 'BUTTON' ||
          role === 'combobox' ||
          className.includes('select__input');

        if (interactive) {
          const typeQuery = isCountryCode ? targetCountryName : selectValue;
          const countryMatcher: OptionTextMatcher = (optText) =>
            new RegExp(`(?:${targetCountryName}|\\${targetDialCode})`, 'i').test(optText);
          const selected = await fillSearchableSelectInput(
            page,
            found.locator,
            found.selector,
            typeQuery,
            isCountryCode ? countryMatcher : isSponsorship || booleanValue ? fuzzyOptionTextMatch : exactOptionTextMatch
          );

          if (selected) {
            fillResult.success = true;
            if (isCountryCode) {
              console.log(
                `[Submitter] Country code field → selector: ${found.selector} → attempted value: ${val || targetDialCode} → result: filled`
              );
            } else if (booleanValue && !isSponsorship) {
              console.log(
                `[Submitter] Boolean field "${fieldId}" → selector: ${found.selector} → value: ${booleanValue} → clicked ✅`
              );
            }
          } else {
            // Do not press Enter on React-Select comboboxes — it clears the filter without selecting (see debug-d34e5e).
            fillResult.success = false;
            if (isSponsorship) {
              const fieldDump = await found.locator
                .evaluate((el: HTMLElement) => {
                  const root =
                    el.closest('.field-wrapper') ||
                    el.closest('.select-shell') ||
                    el.parentElement;
                  return (root?.outerHTML || el.outerHTML).slice(0, 5000);
                })
                .catch(() => '');
              console.warn(
                `[Submitter] Sponsorship combobox fill failed → selector: ${found.selector} → field HTML snippet:\n${fieldDump}`
              );
              const debugFilled = await debugSponsorshipComboboxSequence(page, selectValue);
              if (debugFilled) fillResult.success = true;
            }
          }

          if (fieldId.includes('hispanic') || name.includes('hispanic')) {
            await page.waitForTimeout(500);
          }
        } else {
          // Native HTML <select> (supports Select2 hidden elements via force: true)
          let selected = false;

          if (isCountryCode) {
            try {
              const optionsList = await found.locator.locator('option').allInnerTexts();
              const matchOpt = optionsList.find((opt) =>
                opt.includes(targetCountryName) || opt.includes(targetDialCode)
              );
              if (matchOpt) {
                await found.locator.selectOption({ label: matchOpt.trim() }, { force: true, timeout: 2000 });
                selected = true;
              }
            } catch {}
          } else if (isSponsorship) {
            try {
              const optionsList = await found.locator.locator('option').allInnerTexts();
              const target = selectValue.trim().toLowerCase();
              const matchOpt = optionsList.find((opt) => {
                const o = opt.trim().toLowerCase();
                return o === target || (target === 'yes' && /^yes\b/.test(o)) || (target === 'no' && /^no\b/.test(o));
              });
              if (matchOpt) {
                await found.locator.selectOption({ label: matchOpt.trim() }, { force: true, timeout: 2000 });
                selected = true;
              }
            } catch {}
          }

          // Fallback standard options matching
          if (!selected) {
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
          }

          // Trigger change events natively and on jQuery for Select2 UI sync
          await found.locator.evaluate((el: HTMLSelectElement) => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof (window as any).$ !== 'undefined') {
              (window as any).$(el).trigger('change');
            }
          }).catch(() => {});

          if (selected) {
            fillResult.success = true;
            if (isCountryCode) {
              console.log(
                `[Submitter] Country code field → selector: ${found.selector} → attempted value: ${val || targetDialCode} → result: filled`
              );
            } else if (isSponsorship) {
              console.log(
                `[Submitter] Sponsorship field → selector: ${found.selector} → attempted click: Yes → result: selected`
              );
            } else if (booleanValue) {
              console.log(
                `[Submitter] Boolean field "${fieldId}" → selector: ${found.selector} → value: ${booleanValue} → selected ✅`
              );
            }
          } else {
            throw new Error(`Could not select option "${val}" in ${found.selector}`);
          }
        }
      } else {
        if (isSponsorship) {
          console.log(`[Sponsorship DEBUG] No selector matched — trying [role="combobox"] sequence directly`);
          const debugFilled = await debugSponsorshipComboboxSequence(page, selectValue);
          if (debugFilled) {
            fillResult.success = true;
            return fillResult;
          }
        }
        // Fallback: Select2, remix-css combobox, or role=combobox on page
        const searchable = await findSearchableSelectControl(
          page,
          fieldId,
          name,
          label,
          (field as any).metadata?.selector
        );
        if (searchable) {
          const selected = await fillSearchableSelectInput(page, searchable.locator, searchable.selector, selectValue);
          if (selected) {
            fillResult.success = true;
            return fillResult;
          }
        }

        const select2Trigger = page.locator(
          `[id*="select2-${escapeId(name)}"], [id*="select2-${escapeId(fieldId)}"], .select2-selection, .css-control, input[role="combobox"], [aria-combobox="true"]`
        ).first();

        const count = await select2Trigger.count();
        if (count > 0) {
          const selected = await fillSearchableSelectInput(page, select2Trigger, 'combobox-fallback', selectValue);
          if (selected) {
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

          const isSponsorshipMatch = isSponsorship && (/^yes\b/i.test(cleanLabel) || /^yes\b/i.test(cleanTarget) || ['true', '1'].includes(radioVal?.toLowerCase() || ''));
          if (cleanLabel === cleanTarget || (radioVal && radioVal.toLowerCase() === cleanTarget) || isSponsorshipMatch) {
            const optionSelector =
              radioVal && booleanValue && radioVal.toLowerCase() === booleanValue.toLowerCase()
                ? `input[type="radio"][value="${booleanValue}"]`
                : `input[type="radio"][name="${escapeAttr(name)}"]`;
            if (isSponsorship) {
              await radio.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
              await radio.click({ force: true, timeout: 3000 });
              console.log(
                `[Submitter] Sponsorship field → selector: ${optionSelector} → attempted click: Yes → result: selected`
              );
            } else if (booleanValue) {
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
        const labelLoc = isSponsorship
          ? page.locator('label').filter({ hasText: /^yes\b/i }).first()
          : page.locator('label').filter({ hasText: val }).first();
        if ((await labelLoc.count()) > 0) {
          if (isSponsorship) {
            await labelLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await labelLoc.click({ force: true });
            console.log(
              `[Submitter] Sponsorship field → selector: label:has-text("Yes") → attempted click: Yes → result: selected`
            );
          } else if (booleanValue) {
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
        if (isSponsorship) {
          console.log(
            `[Submitter] Sponsorship field → selector: input[type="radio"][name="${escapeAttr(name)}"] → attempted click: Yes → result: NOT SELECTED`
          );
        }
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
          const booleanValue = normalizeBooleanValue(val);
          const selectAnswer = booleanValue || val;
          fillResult.success = await fillInteractiveSelectDropdown(page, found.locator, selectAnswer);
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
              const targetCountryCode = 'us';
              const targetCountry = 'United States';
              const targetDial = '+1';

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

                const alreadyMatches = combinedStatus.includes('united states') || combinedStatus.includes('+1');

                if (!alreadyMatches) {
                  console.log(`[Form Filler] 📞 Setting intl-tel-input country to United States (+1)`);
                  await flagBtn.click({ timeout: 2000 }).catch(() => {});
                  await page.waitForTimeout(200);

                  const countryItem = page.locator(
                    `li.iti__country[data-country-code="${targetCountryCode}"], ` +
                    `li.iti__country[data-dial-code="1"], ` +
                    `li.iti__country:has-text("United States")`
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

              // 3. Also check for adjacent modern Greenhouse React-Select or native #country dropdown
              const countryDrop = page.locator('#country, input#country, select#country, select[name="country"]').first();
              if ((await countryDrop.count()) > 0 && (await countryDrop.isVisible())) {
                const isSelected = await countryDrop.evaluate((el: HTMLElement) => {
                  if (el.tagName === 'SELECT') return (el as HTMLSelectElement).selectedIndex > 0;
                  const container = el.closest('.select__control, .select-shell');
                  const singleVal = container?.querySelector('.select__single-value');
                  return Boolean(singleVal && singleVal.textContent?.trim());
                }).catch(() => false);

                if (!isSelected) {
                  console.log(`[Form Filler] 📞 Setting phone country dropdown to United States (+1)`);
                  const tagName = await countryDrop.evaluate((el: HTMLElement) => el.tagName.toUpperCase()).catch(() => 'INPUT');
                  if (tagName === 'SELECT') {
                    const opts = await countryDrop.locator('option').allInnerTexts().catch(() => []);
                    const matchOpt = opts.find((o) => o.includes(targetCountry) || o.includes(targetDial));
                    if (matchOpt) {
                      await countryDrop.selectOption({ label: matchOpt.trim() }, { force: true }).catch(() => {});
                      console.log(
                        `[Submitter] Country code field → selector: #country → attempted value: ${targetDial} → result: filled`
                      );
                    }
                  } else {
                    await countryDrop.scrollIntoViewIfNeeded().catch(() => {});
                    await countryDrop.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(150);
                    await countryDrop.pressSequentially(targetCountry, { delay: 35 });
                    await page.waitForTimeout(300);
                    const opt = page.locator('.select__option, [id*="-option"], [role="option"]').filter({
                      hasText: new RegExp(`(?:${targetCountry}|\\${targetDial})`, 'i'),
                    }).first();
                    if ((await opt.count()) > 0) {
                      await opt.scrollIntoViewIfNeeded().catch(() => {});
                      await opt.click({ force: true, timeout: 2000 }).catch(() => {});
                      console.log(
                        `[Submitter] Country code field → selector: #country → attempted value: ${targetDial} → result: filled`
                      );
                    } else {
                      await page.keyboard.press('Enter').catch(() => {});
                      await page.keyboard.press('Tab').catch(() => {});
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
    if (isCountryCode) {
      console.log(
        `[Submitter] Country code field → selector: ${fieldId} → attempted value: ${val} → result: NOT FILLED`
      );
    }
    if (isSponsorship) {
      console.log(
        `[Submitter] Sponsorship field → selector: ${fieldId} → attempted click: Yes → result: NOT SELECTED`
      );
    }
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
