import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { waitForAshbyApplicationReady } from '../src/submitter/ashbySubmit.js';

process.env.NODE_ENV = 'test';

describe('Ashby Overview Tab Transition & Hydration Timeout', { concurrency: 1 }, () => {
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

  it('automatically clicks "Apply for this Job" button to transition from Overview tab', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div id="overview-tab">
          <h2>Job Description</h2>
          <button id="apply-btn" onclick="
            document.getElementById('overview-tab').style.display = 'none';
            document.getElementById('form-tab').style.display = 'block';
          ">Apply for this Job</button>
        </div>
        <div id="form-tab" style="display: none;">
          <div data-field-path="_systemfield_name">
            <input type="text" name="name" />
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    await waitForAshbyApplicationReady(page, 5000);

    const isFormVisible = await page.$eval('#form-tab', (el) => (el as HTMLElement).style.display === 'block');
    assert.equal(isFormVisible, true, 'Form must be transitioned to visible after clicking Apply for this Job');
  });

  it('automatically clicks role="tab" with text "Application" if present', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div role="tablist">
          <button role="tab">Overview</button>
          <button role="tab" id="tab-app" onclick="
            document.getElementById('app-container').innerHTML = '<div data-field-path=\\'_systemfield_email\\'><input type=\\'text\\' name=\\'email\\' /></div>';
          ">Application</button>
        </div>
        <div id="app-container"></div>
      </body>
      </html>
    `;
    await page.setContent(html);

    await waitForAshbyApplicationReady(page, 5000);

    const hasField = (await page.locator('[data-field-path]').count()) > 0;
    assert.equal(hasField, true, 'Form fields must mount after clicking Application tab');
  });

  it('waits for loading spinner to detach before validating readiness', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="ashby-loading-spinner" id="spinner">Loading...</div>
        <div id="container"></div>
        <script>
          setTimeout(() => {
            const spinner = document.getElementById('spinner');
            if (spinner) spinner.remove();
            document.getElementById('container').innerHTML = '<div data-field-path=\\'_systemfield_name\\'><input type=\\'text\\' name=\\'name\\' /></div>';
          }, 300);
        </script>
      </body>
      </html>
    `;
    await page.setContent(html);

    await waitForAshbyApplicationReady(page, 5000);

    const hasField = (await page.locator('[data-field-path]').count()) > 0;
    assert.equal(hasField, true, 'Must wait for spinner to detach and find field path');
  });

  it('throws descriptive error if application form never appears', async () => {
    const html = `<!DOCTYPE html><html><body><div>Just text</div></body></html>`;
    await page.setContent(html);

    await assert.rejects(
      async () => {
        await waitForAshbyApplicationReady(page, 500);
      },
      /Ashby application form readiness timed out after 500ms/
    );
  });
});
