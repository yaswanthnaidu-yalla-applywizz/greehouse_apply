import fs from 'node:fs';
import path from 'node:path';
import type { Page, Locator } from 'playwright';
import type { ResolvedField } from '../types/index.js';
import { observeAtsVerification } from './atsVerification.js';
import { humanType, pauseBetweenFields } from './humanCadence.js';

export interface RipplingFillResult {
  filledCount: number;
  filledFields: Array<{ fieldId: string; label: string; value: string; controlType: string }>;
}

function byLabel(page: Page, field: ResolvedField): Locator {
  const escaped = field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByLabel(new RegExp('^\\s*' + escaped + '\\s*\\*?\\s*$'));
}

async function byStableControl(page: Page, field: ResolvedField): Promise<Locator> {
  const labeled = byLabel(page, field);
  if (await labeled.count() === 1) return labeled;
  const selector = field.metadata?.selector;
  if (selector) {
    const scoped = page.locator(selector).locator('input, textarea, select, [role="combobox"], [role="textbox"]');
    if (await scoped.count() === 1) return scoped;
  }
  return labeled;
}

async function requireUnique(locator: Locator, field: ResolvedField): Promise<Locator> {
  const count = await locator.count();
  if (count !== 1) throw new Error('Required Rippling field "' + field.label + '" is ' + (count ? 'ambiguous' : 'missing'));
  return locator;
}

async function assertNoHumanChallenge(page: Page): Promise<void> {
  const observation = await observeAtsVerification(page, 'rippling');
  if (observation.kind === 'interactive') throw new Error('Rippling is showing a human verification challenge; form filling stopped');
}

async function uploadResume(page: Page, field: ResolvedField, resumePath: string): Promise<void> {
  if (!fs.existsSync(resumePath)) throw new Error('Rippling resume file does not exist: ' + resumePath);
  const input = await requireUnique(await byStableControl(page, field), field);
  await input.setInputFiles(resumePath);
  const filename = path.basename(resumePath);
  const state = await page.waitForFunction((name) => {
    const text = document.body?.innerText ?? '';
    if (/resume parsing (?:failed|was unsuccessful)|could not parse (?:the )?resume/i.test(text)) return 'failed';
    if (text.includes('File ' + name + ' uploaded successfully') && text.includes('Résumé parsing was successful.')) return 'success';
    return false;
  }, filename, { timeout: 20_000 }).then((handle) => handle.jsonValue() as Promise<'success' | 'failed'>).catch(() => 'timeout' as const);
  if (state === 'failed') throw new Error('Rippling resume parsing failed');
  if (state !== 'success') throw new Error('Rippling did not confirm successful upload and resume parsing');
  await assertNoHumanChallenge(page);
}

async function fillAutocomplete(page: Page, locator: Locator, answer: string, field: ResolvedField): Promise<void> {
  await locator.fill(answer);
  const exactOption = page.getByRole('option', { name: answer, exact: true });
  if (await exactOption.count() !== 1) throw new Error('Required Rippling field "' + field.label + '" has no unique exact option for "' + answer + '"');
  await exactOption.click();
  const committed = await locator.inputValue().then((value) => value.trim() === answer).catch(() => false);
  if (!committed) throw new Error('Required Rippling field "' + field.label + '" option did not commit');
}

async function exactGroupOption(page: Page, field: ResolvedField, answer: string): Promise<Locator> {
  const escaped = field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const groupName = new RegExp('^\\s*' + escaped + '\\s*\\*?\\s*$');
  const role = field.type.toLowerCase() === 'radio' ? 'radio' : 'checkbox';
  const group = field.type.toLowerCase() === 'radio'
    ? page.getByRole('radiogroup', { name: groupName }).or(page.getByRole('group', { name: groupName }))
    : page.getByRole('group', { name: groupName });
  const groupCount = await group.count();
  if (groupCount !== 1) throw new Error('Required Rippling ' + role + ' group "' + field.label + '" is ' + (groupCount ? 'ambiguous' : 'missing'));
  let option = group.getByRole(role, { name: answer, exact: true });
  let optionCount = await option.count();
  if (!optionCount) {
    const escapedAnswer = answer.replace(/["\\]/g, '\\$&');
    option = group.locator('input[type="' + role + '"][value="' + escapedAnswer + '"], [role="' + role + '"][value="' + escapedAnswer + '"], [role="' + role + '"][data-value="' + escapedAnswer + '"]');
    optionCount = await option.count();
  }
  if (optionCount !== 1) throw new Error('Rippling ' + role + ' answer "' + answer + '" for "' + field.label + '" is ' + (optionCount ? 'ambiguous' : 'not an exact option'));
  return option;
}

async function isGroupOptionCommitted(option: Locator): Promise<boolean> {
  const tag = await option.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tag === 'input') return option.isChecked().catch(() => false);
  return option.getAttribute('aria-checked').then((value) => value === 'true').catch(() => false);
}

async function commitGroupOption(page: Page, field: ResolvedField, answer: string): Promise<Locator> {
  const option = await exactGroupOption(page, field, answer);
  const tag = await option.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
  if (tag === 'input') await option.check();
  else if (!(await isGroupOptionCommitted(option))) await option.click();
  if (!(await isGroupOptionCommitted(option))) throw new Error('Rippling ' + field.type + ' option "' + answer + '" for "' + field.label + '" did not commit');
  return option;
}

export async function fillRipplingForm(
  page: Page,
  resolvedFields: ResolvedField[],
  resumeLocalPath: string,
): Promise<RipplingFillResult> {
  if (!resumeLocalPath || !fs.existsSync(resumeLocalPath)) {
    throw new Error('Rippling resume file does not exist: ' + resumeLocalPath);
  }
  await assertNoHumanChallenge(page);
  const filledFields: RipplingFillResult['filledFields'] = [];
  for (const field of resolvedFields.filter((item) => item.type.toLowerCase() === 'file')) {
    if (/^(resume|cv)$/i.test(field.label.trim())) {
      await uploadResume(page, field, resumeLocalPath);
      filledFields.push({ fieldId: field.fieldId, label: field.label, value: path.basename(resumeLocalPath), controlType: 'file' });
    } else if (field.isRequired) {
      throw new Error('Unsupported required Rippling file field "' + field.label + '"');
    }
  }

  for (const field of resolvedFields) {
    await assertNoHumanChallenge(page);
    const type = field.type.toLowerCase();
    if (type === 'file') continue;
    const answer = String(field.value ?? '').trim();
    if (!answer) {
      if (field.isRequired) throw new Error('Required Rippling field "' + field.label + '" is unresolved');
      continue;
    }
    if (type === 'radio' || type === 'checkbox') {
      await commitGroupOption(page, field, answer);
      filledFields.push({ fieldId: field.fieldId, label: field.label, value: answer, controlType: type });
      continue;
    }
    if (!['text', 'textarea', 'email', 'tel', 'url', 'date', 'select'].includes(type)) {
      if (field.isRequired) throw new Error('Unsupported required Rippling field type "' + field.type + '" for "' + field.label + '"');
      continue;
    }
    let locator = await byStableControl(page, field);
    if (await locator.count() !== 1) {
      if (field.isRequired) await requireUnique(locator, field);
      continue;
    }
    if (type === 'select') {
      const role = await locator.getAttribute('role').catch(() => null);
      const tag = await locator.evaluate((element) => element.tagName.toLowerCase()).catch(() => '');
      if (role === 'combobox' || tag === 'input') {
        await fillAutocomplete(page, locator, answer, field);
      } else if (tag === 'select') {
        await locator.selectOption({ label: answer });
        if (await locator.locator('option:checked').textContent().then((text) => text?.trim() !== answer).catch(() => true)) {
          throw new Error('Required Rippling field "' + field.label + '" option did not commit');
        }
      } else if (field.isRequired) {
        throw new Error('Unsupported required Rippling select control for "' + field.label + '"');
      } else continue;
    } else if (field.label.toLowerCase().includes('location')) {
      await fillAutocomplete(page, locator, answer, field);
    } else {
      await humanType(locator, answer);
      await pauseBetweenFields(page);
    }
    const committed = type === 'select'
      ? true
      : await locator.inputValue().then((value) => value === answer).catch(() => false);
    if (!committed && field.isRequired) throw new Error('Required Rippling field "' + field.label + '" value did not commit');
    if (committed) filledFields.push({ fieldId: field.fieldId, label: field.label, value: answer, controlType: field.type });
  }

  for (const field of resolvedFields.filter((item) => item.isRequired)) {
    if (field.type.toLowerCase() === 'file') continue; // Upload and parse success are confirmed above.
    if (field.type.toLowerCase() === 'radio' || field.type.toLowerCase() === 'checkbox') {
      const option = await exactGroupOption(page, field, String(field.value ?? '').trim());
      if (!(await isGroupOptionCommitted(option))) throw new Error('Required Rippling ' + field.type + ' value for "' + field.label + '" is not committed');
      continue;
    }
    const locator = await requireUnique(await byStableControl(page, field), field);
    const value = await locator.inputValue().catch(() => '');
    if (!value.trim()) throw new Error('Required Rippling field "' + field.label + '" is not committed');
  }
  await assertNoHumanChallenge(page);
  return { filledCount: filledFields.length, filledFields };
}
