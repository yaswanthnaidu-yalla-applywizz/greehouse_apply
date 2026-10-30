/**
 * Test for RC-ASH-2b: dispatchReactChangeEvent helper ensuring
 * React-controlled inputs/selects on Ashby receive synthetic events so state commits.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { fillAshbyForm, verifyRequiredFieldsCommitted, dispatchReactChangeEvent } from '../src/submitter/ashbyFormFiller.js';
import type { ResolvedField } from '../src/types/index.js';

process.env.NODE_ENV = 'test';

describe('RC-ASH-2b: Ashby React synthetic change/input dispatch on custom fields', () => {
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

  it('exports dispatchReactChangeEvent function', () => {
    assert.equal(typeof dispatchReactChangeEvent, 'function');
  });

  it('dispatches synthetic change and input events on custom input field', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="4645121d-997a-4781-bcdb-da07c00dc3f2">
          <input type="text" id="customInput" name="custom_experience" value="" />
        </div>
        <script>
          window.__eventLog = [];
          const el = document.getElementById('customInput');
          el.addEventListener('input', () => window.__eventLog.push('input'));
          el.addEventListener('change', () => window.__eventLog.push('change'));
        </script>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: '4645121d-997a-4781-bcdb-da07c00dc3f2',
        name: 'custom_experience',
        label: 'How many years of experience?',
        value: '6 years',
        type: 'text',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');
    assert.equal(result.filledCount, 1);

    const logs = await page.evaluate(() => (window as any).__eventLog);
    assert.ok(logs.includes('input'), 'Expected input event to be dispatched');
    assert.ok(logs.includes('change'), 'Expected change event to be dispatched');

    const check = await verifyRequiredFieldsCommitted(page, ['4645121d-997a-4781-bcdb-da07c00dc3f2']);
    assert.equal(check.allCommitted, true);
  });
});
