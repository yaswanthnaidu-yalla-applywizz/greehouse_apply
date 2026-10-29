/**
 * Test for Fix 4a / Fix 10: Turnstile / Challenge detection at preflight/navigation.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { detectInteractiveChallenge } from '../src/submitter/ashbySubmit.js';

process.env.NODE_ENV = 'test';

describe('Turnstile & Challenge Detection', () => {
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

  it('detects visible Cloudflare Turnstile challenge iframe', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div id="challenge-stage">
          <iframe title="Widget containing a Cloudflare security challenge" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1" style="display: block; width: 300px; height: 65px;">
            Verify you are human
          </iframe>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const challenge = await detectInteractiveChallenge(page);
    assert.equal(challenge.detected, true);
    assert.equal(challenge.challengeType, 'turnstile');
  });

  it('returns detected: false when no challenge is present', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <form>
          <input type="text" name="name" value="Candidate" />
        </form>
      </body>
      </html>
    `;
    await page.setContent(html);

    const challenge = await detectInteractiveChallenge(page);
    assert.equal(challenge.detected, false);
  });
});
