import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Locator, type Page, type Response } from 'playwright';
import { PlaywrightScanner } from '../src/scanner/playwrightScanner.js';
import type { ScannedField } from '../src/types/index.js';

const JOB_URL = 'https://job-boards.eu.greenhouse.io/imc/jobs/4908708101';
const OUTPUT_PATH = path.resolve('output/imc_job_4908708101_scan.txt');
const MAX_SCROLL_PASSES = 3;

async function networkSummary(response: Response): Promise<object | null> {
  if (!['xhr', 'fetch'].includes(response.request().resourceType())) return null;
  const headers = await response.allHeaders();
  if (!headers['content-type']?.includes('json')) return null;
  const url = new URL(response.url());
  const result: { path: string; status: number; matchingStrings: string[] } = {
    path: url.pathname,
    status: response.status(),
    matchingStrings: [],
  };
  try {
    const data = await response.json();
    const visit = (value: unknown, depth: number): void => {
      if (depth > 8 || result.matchingStrings.length >= 8) return;
      if (typeof value === 'string' && /\b(school|university|college|degree)\b/i.test(value)) {
        result.matchingStrings.push(value.trim().slice(0, 120));
      } else if (Array.isArray(value)) {
        value.slice(0, 2000).forEach((item) => visit(item, depth + 1));
      } else if (value && typeof value === 'object') {
        Object.values(value as Record<string, unknown>)
          .slice(0, 500)
          .forEach((item) => visit(item, depth + 1));
      }
    };
    visit(data, 0);
  } catch {
    // Keep endpoint metadata even when a response body is not readable JSON.
  }
  return result;
}

async function customControl(page: Page, field: ScannedField): Promise<Locator | null> {
  for (const value of [field.name, field.fieldId]) {
    if (!value) continue;
    const label = page.locator(`label[for=${JSON.stringify(value)}]`).first();
    if (await label.count() && await label.isVisible()) {
      const control = label.locator('xpath=..').locator(
        '[role="combobox"], .select__input, .select__control, [aria-haspopup="listbox"]',
      ).first();
      if (await control.count() && await control.isVisible()) return control;
    }
    const byId = page.locator(`[id=${JSON.stringify(value)}]`);
    for (let index = 0; index < await byId.count(); index++) {
      const candidate = byId.nth(index);
      if (!(await candidate.isVisible())) continue;
      if (await candidate.evaluate((element) => element.tagName) !== 'SELECT') return candidate;
    }
  }
  return null;
}

async function readVisibleOptions(page: Page): Promise<string[]> {
  const loc = page.locator('[role="option"]:visible, .select__option:visible, [id*="-option"]:visible');
  const values: string[] = [];
  for (let i = 0; i < await loc.count(); i++) {
    const text = (await loc.nth(i).innerText()).trim();
    if (text) values.push(text);
  }
  return values;
}

async function scrollOnePage(page: Page): Promise<{ hasMenu: boolean; bottom: boolean }> {
  const menu = page.locator('[role="listbox"]:visible, [class*="menu"]:visible').last();
  if (!(await menu.count())) return { hasMenu: false, bottom: false };
  return menu.evaluate((element) => {
    let scroller: HTMLElement | null = element as HTMLElement;
    while (scroller && scroller !== document.body &&
      scroller.scrollHeight <= scroller.clientHeight + 2) scroller = scroller.parentElement;
    if (!scroller || scroller === document.body) return { hasMenu: true, bottom: true };
    scroller.scrollTop = Math.min(
      scroller.scrollHeight,
      scroller.scrollTop + Math.max(scroller.clientHeight * 0.8, 100),
    );
    return {
      hasMenu: true,
      bottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
    };
  });
}

async function inspectRequiredSelects(page: Page, fields: ScannedField[]) {
  const diagnostics = [];
  for (const field of fields) {
    if (field.type !== 'select') continue;
    const diagnostic = {
      fieldId: field.fieldId,
      label: field.label,
      required: field.isRequired,
      optionCount: field.options?.length || 0,
      partial: false,
      method: field.isRequired ? 'bounded custom-menu scan' : 'skipped optional',
    };
    diagnostics.push(diagnostic);
    if (!field.isRequired) continue;

    const control = await customControl(page, field);
    if (!control) {
      diagnostic.method = 'native or no visible custom control';
      continue;
    }

    const options = new Set(field.options || []);
    let stableBottomPasses = 0;
    let foundMenu = false;
    try {
      await control.click({ timeout: 1200 });
      await page.waitForTimeout(150);
      for (let pass = 0; pass < MAX_SCROLL_PASSES; pass++) {
        const before = options.size;
        (await readVisibleOptions(page)).forEach((option) => options.add(option));
        const scroll = await scrollOnePage(page);
        foundMenu ||= scroll.hasMenu;
        await page.waitForTimeout(250);
        (await readVisibleOptions(page)).forEach((option) => options.add(option));
        stableBottomPasses = scroll.hasMenu && scroll.bottom && options.size === before
          ? stableBottomPasses + 1
          : 0;
        if (stableBottomPasses >= 2) break;
      }
      field.options = [...options];
      diagnostic.optionCount = options.size;
      diagnostic.partial = !foundMenu || options.size === 0 || stableBottomPasses < 2;
    } finally {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  return diagnostics;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const networkTasks: Promise<object | null>[] = [];
    page.on('response', (response) => {
      if (networkTasks.length < 30) networkTasks.push(networkSummary(response));
    });
    const scanner = new PlaywrightScanner({ headless: true, minJitterMs: 0, maxJitterMs: 0 });
    const template = await scanner.scanSingleUrl(JOB_URL, page, true);
    const choiceDiagnostics = await inspectRequiredSelects(page, template.fields);
    const networkOptionSourceEvidence = (await Promise.all(networkTasks)).filter(Boolean);
    const school = template.fields.find((field) => /\bschool\b/i.test(field.label));
    const output = {
      scannedAt: new Date().toISOString(),
      jobUrl: JOB_URL,
      jobTitle: template.jobTitle,
      companyName: template.companyName,
      isExpired: template.isExpired,
      fields: template.fields,
      requiredChoiceDiagnostics: choiceDiagnostics.filter((item) => item.required),
      schoolDiagnostic: school ? {
        required: school.isRequired,
        optionCount: school.options?.length || 0,
        partial: choiceDiagnostics.find((item) => item.fieldId === school.fieldId)?.partial ?? false,
      } : null,
      networkOptionSourceEvidence,
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(`Scanned ${JOB_URL}`);
    console.log(`Fields: ${template.fields.length}; required select questions: ${output.requiredChoiceDiagnostics.length}`);
    console.log(
      `School required: ${school?.isRequired ?? 'not found'}; options captured: ${school?.options?.length || 0}; partial: ${output.schoolDiagnostic?.partial ?? false}`,
    );
    console.log(`Saved scan and diagnostics to ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
