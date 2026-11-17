import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { fillAshbyForm } from '../src/submitter/ashbyFormFiller.js';
import type { ResolvedField } from '../src/types/index.js';

process.env.NODE_ENV = 'test';

describe('Ashby Boolean Checkbox Option Routing Fix', () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  });

  it('checks single agreement checkbox when field has synthetic option ["true"] and answer is "true"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="arb_agreement">
          <label class="ashby-application-form-question-title">Arbitration Agreement</label>
          <div class="ashby-application-form-input-checkbox-group">
            <label id="arb-label">
              <input type="checkbox" id="checkbox-arb" name="arb"> I acknowledge the Arbitration Agreement
            </label>
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'arb_agreement',
        name: 'arb_agreement',
        label: 'Arbitration Agreement',
        value: 'true',
        type: 'checkbox',
        isRequired: true,
        options: ['true'],
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');

    const isChecked = await page.$eval('#checkbox-arb', (el) => (el as HTMLInputElement).checked);
    assert.equal(isChecked, true, 'Agreement checkbox must be checked even with synthetic options: ["true"]');
    assert.equal(result.filledCount, 1, 'Should record 1 filled field');
  });

  it('checks multi-option checkbox matching specific option answer', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="workplace_pref">
          <label class="ashby-application-form-question-title">Workplace Preference</label>
          <div class="ashby-application-form-input-checkbox-group">
            <label id="label-remote">
              <input type="checkbox" id="checkbox-remote" value="Remote"> Remote
            </label>
            <label id="label-onsite">
              <input type="checkbox" id="checkbox-onsite" value="Onsite"> Onsite
            </label>
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'workplace_pref',
        name: 'workplace_pref',
        label: 'Workplace Preference',
        value: 'Remote',
        type: 'checkbox',
        isRequired: true,
        options: ['Remote', 'Onsite'],
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');

    const isRemoteChecked = await page.$eval('#checkbox-remote', (el) => (el as HTMLInputElement).checked);
    const isOnsiteChecked = await page.$eval('#checkbox-onsite', (el) => (el as HTMLInputElement).checked);

    assert.equal(isRemoteChecked, true, '"Remote" checkbox must be checked');
    assert.equal(isOnsiteChecked, false, '"Onsite" checkbox must remain unchecked');
    assert.equal(result.filledCount, 1, 'Should record 1 filled field');
  });

  it('leaves single boolean checkbox unchecked when answer is "false"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="opt_in_marketing">
          <label class="ashby-application-form-question-title">Marketing Opt-in</label>
          <div class="ashby-application-form-input-checkbox-group">
            <label id="label-opt-in">
              <input type="checkbox" id="checkbox-opt-in"> Send me updates
            </label>
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'opt_in_marketing',
        name: 'opt_in_marketing',
        label: 'Marketing Opt-in',
        value: 'false',
        type: 'checkbox',
        isRequired: false,
        options: ['false'],
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');

    const isChecked = await page.$eval('#checkbox-opt-in', (el) => (el as HTMLInputElement).checked);
    assert.equal(isChecked, false, 'Checkbox should remain unchecked when answer is false');
    assert.equal(result.filledCount, 1, 'Should record 1 filled field as verified unchecked');
  });
});
