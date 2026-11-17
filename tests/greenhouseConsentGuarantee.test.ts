import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { ensureRequiredConsentCheckboxes } from '../src/submitter/formFiller.js';
import { DEFAULT_OTP_RESOLUTION_TIMEOUT_MS } from '../src/services/otpResolutionService.js';

process.env.NODE_ENV = 'test';

describe('Greenhouse Mandatory Consent Checkbox Guarantee & OTP Window', { concurrency: 1 }, () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page) await page.close().catch(() => {});
  });

  it('automatically checks mandatory consent checkboxes with required attribute', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label>
            <input type="checkbox" id="confidential_info" required />
            I acknowledge that I have read the Zscaler Confidential Information terms.
          </label>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const checkedBefore = await page.isChecked('#confidential_info');
    assert.equal(checkedBefore, false);

    const count = await ensureRequiredConsentCheckboxes(page);
    assert.equal(count, 1, 'Must check 1 mandatory checkbox');

    const checkedAfter = await page.isChecked('#confidential_info');
    assert.equal(checkedAfter, true, 'Checkbox must be checked after guarantee sweep');
  });

  it('automatically checks mandatory consent checkboxes marked with asterisk in label', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label>I certify all statements are true *</label>
          <input type="checkbox" id="certify" />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const count = await ensureRequiredConsentCheckboxes(page);
    assert.equal(count, 1);

    const isChecked = await page.isChecked('#certify');
    assert.equal(isChecked, true);
  });

  it('leaves optional marketing / SMS checkboxes unchecked', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label>
            <input type="checkbox" id="opt_marketing" />
            Send me marketing emails about new roles (optional)
          </label>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const count = await ensureRequiredConsentCheckboxes(page);
    assert.equal(count, 0, 'Must not check optional checkboxes');

    const isChecked = await page.isChecked('#opt_marketing');
    assert.equal(isChecked, false, 'Optional checkbox must remain unchecked');
  });

  it('verifies default OTP resolution timeout is 180,000ms (180s)', () => {
    assert.equal(DEFAULT_OTP_RESOLUTION_TIMEOUT_MS, 180000);
  });
});
