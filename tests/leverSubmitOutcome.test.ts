import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  captureLeverSubmitOutcomeBaseline,
  waitForLeverSubmitOutcome,
} from '../src/submitter/leverSubmit.js';

describe('Lever submit outcome confirmation', () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  it('keeps a token-only page unconfirmed', async () => {
    await page.setContent('<input id="hcaptchaResponseInput" value="fixture-token-that-is-long-enough">');
    assert.equal(
      await waitForLeverSubmitOutcome(page, { timeoutMs: 50, pollIntervalMs: 10 }),
      'unconfirmed'
    );
  });

  it('does not treat a token followed by a rejection as confirmation', async () => {
    await page.setContent(`
      <input id="hcaptchaResponseInput" value="fixture-token-that-is-long-enough">
      <div role="alert">Application could not be submitted. Please try again.</div>
    `);
    assert.equal(
      await waitForLeverSubmitOutcome(page, { timeoutMs: 50, pollIntervalMs: 10 }),
      'unconfirmed'
    );
  });

  it('does not treat a hidden receipt template as confirmation', async () => {
    await page.setContent('<div data-qa="application-receipt" hidden>Application received</div>');
    assert.equal(
      await waitForLeverSubmitOutcome(page, { timeoutMs: 50, pollIntervalMs: 10 }),
      'unconfirmed'
    );
  });

  it('does not treat a visible receipt that predates Apply as confirmation', async () => {
    await page.setContent('<div data-qa="application-receipt">Application received</div>');
    const baseline = await captureLeverSubmitOutcomeBaseline(page);
    assert.equal(
      await waitForLeverSubmitOutcome(page, { baseline, timeoutMs: 50, pollIntervalMs: 10 }),
      'unconfirmed'
    );
  });

  it('does not treat a /thanks URL that predates Apply as confirmation', async () => {
    await page.route('https://lever-fixture.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<main>Previously completed</main>' })
    );
    await page.goto('https://lever-fixture.test/thanks');
    const baseline = await captureLeverSubmitOutcomeBaseline(page);
    assert.equal(
      await waitForLeverSubmitOutcome(page, { baseline, timeoutMs: 50, pollIntervalMs: 10 }),
      'unconfirmed'
    );
  });

  it('recognizes a delayed application receipt', async () => {
    await page.setContent(`
      <script>
        setTimeout(() => {
          const receipt = document.createElement('div');
          receipt.dataset.qa = 'application-receipt';
          receipt.textContent = 'Application received';
          document.body.append(receipt);
        }, 7000);
      </script>
    `);
    assert.equal(await waitForLeverSubmitOutcome(page), 'confirmed');
  });

  it('returns challenge for a visible hCaptcha puzzle', async () => {
    await page.setContent(`
      <div class="h-captcha">
        <iframe src="https://newassets.hcaptcha.com/captcha/v1/puzzle" srcdoc="<body>Select all images with a bus</body>" title="hCaptcha" style="visibility: visible; display: block; width: 350px; height: 450px"></iframe>
      </div>
    `);
    assert.equal(await waitForLeverSubmitOutcome(page, { timeoutMs: 100, pollIntervalMs: 10 }), 'challenge');
  });

  it('times out a spinner as unconfirmed', async () => {
    await page.setContent('<div role="progressbar">Submitting</div>');
    assert.equal(
      await waitForLeverSubmitOutcome(page, { timeoutMs: 50, pollIntervalMs: 10 }),
      'unconfirmed'
    );
  });
});
