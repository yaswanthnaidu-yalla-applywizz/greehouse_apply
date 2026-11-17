import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { fillAshbyForm } from '../src/submitter/ashbyFormFiller.js';
import type { ResolvedField } from '../src/types/index.js';

process.env.NODE_ENV = 'test';

describe('Ashby Radio Button Selector Precision (Eliminate Header Collision)', () => {
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

  it('targets "No" radio option without clicking question title containing "now"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="_systemfield_sponsorship">
          <label class="ashby-application-form-question-title" id="question-header">Will you now or in the future require sponsorship?</label>
          <div class="ashby-application-form-input-radio-group">
            <label class="ashby-application-form-input-radio-group-option-label" id="label-yes">
              <input type="radio" value="Yes" name="sponsorship" id="radio-yes">Yes
            </label>
            <label class="ashby-application-form-input-radio-group-option-label" id="label-no">
              <input type="radio" value="No" name="sponsorship" id="radio-no">No
            </label>
          </div>
        </div>
        <script>
          window.__clickedElements = [];
          document.getElementById('question-header').addEventListener('click', () => {
            window.__clickedElements.push('header');
          });
          document.getElementById('label-yes').addEventListener('click', () => {
            window.__clickedElements.push('label-yes');
          });
          document.getElementById('label-no').addEventListener('click', () => {
            window.__clickedElements.push('label-no');
          });
        </script>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: '_systemfield_sponsorship',
        name: '_systemfield_sponsorship',
        label: 'Will you now or in the future require sponsorship?',
        value: 'No',
        type: 'radio',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');

    const clicked = await page.evaluate(() => (window as any).__clickedElements);
    const isNoChecked = await page.$eval('#radio-no', (el) => (el as HTMLInputElement).checked);

    assert.equal(clicked.includes('header'), false, 'Question title header must never be clicked');
    assert.equal(isNoChecked, true, 'The "No" radio button must be checked');
    assert.equal(result.filledCount, 1, 'Field should be recorded as filled');
  });

  it('targets "Yes" radio option properly when answer is "Yes"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="_systemfield_sponsorship">
          <label class="ashby-application-form-question-title" id="question-header">Will you now or in the future require sponsorship?</label>
          <div class="ashby-application-form-input-radio-group">
            <label class="ashby-application-form-input-radio-group-option-label" id="label-yes">
              <input type="radio" value="Yes" name="sponsorship" id="radio-yes">Yes
            </label>
            <label class="ashby-application-form-input-radio-group-option-label" id="label-no">
              <input type="radio" value="No" name="sponsorship" id="radio-no">No
            </label>
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: '_systemfield_sponsorship',
        name: '_systemfield_sponsorship',
        label: 'Will you now or in the future require sponsorship?',
        value: 'Yes',
        type: 'radio',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');
    const isYesChecked = await page.$eval('#radio-yes', (el) => (el as HTMLInputElement).checked);

    assert.equal(isYesChecked, true, 'The "Yes" radio button must be checked');
    assert.equal(result.filledCount, 1, 'Field should be recorded as filled');
  });

  it('falls back to input[type="radio"][value] if label class is absent', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="work_auth">
          <label class="ashby-application-form-question-title" id="question-header">Do you not require sponsorship?</label>
          <div>
            <input type="radio" value="No" name="auth" id="radio-auth-no">
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'work_auth',
        name: 'work_auth',
        label: 'Do you not require sponsorship?',
        value: 'No',
        type: 'radio',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');
    const isNoChecked = await page.$eval('#radio-auth-no', (el) => (el as HTMLInputElement).checked);

    assert.equal(isNoChecked, true, 'The fallback radio input should be checked');
    assert.equal(result.filledCount, 1);
  });
});
