import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  detectInteractiveChallenge,
  waitForSubmitConfirmation,
  type ChallengeDetectionResult,
} from '../src/submitter/ashbySubmit.js';

process.env.NODE_ENV = 'test';

describe('Ashby Instant Interactive Challenge Quarantine (3s Grace Window)', () => {
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

  it('Test 1: Invisible Turnstile token passing does not trigger interactive challenge detection', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Ashby Job Application</title></head>
      <body>
        <form id="ashby-application-form">
          <input type="text" name="name" value="Jane Doe" />
          <div id="cf-turnstile">
            <input type="hidden" name="cf-turnstile-response" value="0.invisible-auto-passed-token-xyz" />
            <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/v0/api.js" style="display: none; width: 0; height: 0;"></iframe>
          </div>
        </form>
      </body>
      </html>
    `;
    await page.setContent(html);

    const result: ChallengeDetectionResult = await detectInteractiveChallenge(page);
    assert.equal(result.detected, false, 'Invisible Turnstile should not be detected as interactive challenge');
    assert.equal(result.challengeType, undefined);
  });

  it('Test 2: Visible hCaptcha puzzle modal triggers immediate detection with challengeType: "hcaptcha"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Ashby Job Application</title></head>
      <body>
        <div class="hcaptcha-box" style="position: fixed; top: 100px; left: 100px; width: 350px; height: 450px; display: block;">
          <iframe src="https://newassets.hcaptcha.com/captcha/v1/..." style="display: block; visibility: visible; width: 350px; height: 450px;"></iframe>
          <div>Select all images with a train</div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const result: ChallengeDetectionResult = await detectInteractiveChallenge(page);
    assert.equal(result.detected, true, 'Visible hCaptcha puzzle modal must be detected');
    assert.equal(result.challengeType, 'hcaptcha');
    assert.ok(result.details?.includes('hcaptcha'), 'Details should mention hcaptcha');
  });

  it('Test 3: Cloudflare interactive challenge popup triggers detection with challengeType: "turnstile"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Ashby Job Application</title></head>
      <body>
        <div id="challenge-stage" class="challenge-popup" style="display: block; width: 300px; height: 100px;">
          <iframe title="Widget containing a Cloudflare security challenge" style="display: block; width: 300px; height: 65px;">
            Verify you are human
          </iframe>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const result: ChallengeDetectionResult = await detectInteractiveChallenge(page);
    assert.equal(result.detected, true, 'Cloudflare interactive challenge must be detected');
    assert.equal(result.challengeType, 'turnstile');
    assert.ok(result.details?.includes('turnstile'), 'Details should mention turnstile');
  });

  it('Test 4: Fast quarantine aborts post-submit confirmation loop at ~3s rather than burning 45s', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Ashby Job Application</title></head>
      <body>
        <form>
          <button type="submit" class="ashby-application-form-submit-button">Submit Application</button>
        </form>
        <div id="challenge-stage" class="challenge-popup" style="display: block; width: 300px; height: 100px;">
          <iframe title="Widget containing a Cloudflare security challenge">
            Verify you are human
          </iframe>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const startTime = Date.now();
    let detectedType: string | undefined;

    await assert.rejects(
      async () => {
        await waitForSubmitConfirmation(page, {
          timeoutMs: 45000,
          graceWindowMs: 3000,
          pollIntervalMs: 500,
          onChallengeDetected: (c) => {
            detectedType = c.challengeType;
          },
        });
      },
      (err: any) => {
        assert.equal(err.classification, 'EXTERNAL_POLICY:INTERACTIVE_CHALLENGE');
        assert.equal(err.challengeType, 'turnstile');
        assert.match(err.message, /External policy block: Interactive turnstile CAPTCHA intercepted submit/);
        return true;
      }
    );

    const elapsedMs = Date.now() - startTime;
    assert.equal(detectedType, 'turnstile');
    assert.ok(
      elapsedMs >= 2900 && elapsedMs < 10000,
      `Expected fast quarantine around ~3s grace window, but took ${elapsedMs}ms`
    );
  });

  it('Test 5: Success signal confirms immediately and bypasses challenge check', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Application Submitted</title></head>
      <body>
        <div>Your application was successfully submitted. We'll contact you if there are next steps.</div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const startTime = Date.now();
    const confirmed = await waitForSubmitConfirmation(page, {
      timeoutMs: 45000,
      graceWindowMs: 3000,
      pollIntervalMs: 200,
    });

    const elapsed = Date.now() - startTime;
    assert.equal(confirmed, true);
    assert.ok(elapsed < 2000, `Confirmed in ${elapsed}ms, well before grace window`);
  });

  it('Test 6: Visible reCAPTCHA challenge modal triggers detection with challengeType: "recaptcha"', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Ashby Job Application</title></head>
      <body>
        <iframe src="https://www.google.com/recaptcha/api2/bframe" title="recaptcha challenge" style="display: block; width: 300px; height: 400px;"></iframe>
      </body>
      </html>
    `;
    await page.setContent(html);

    const result: ChallengeDetectionResult = await detectInteractiveChallenge(page);
    assert.equal(result.detected, true, 'reCAPTCHA challenge modal must be detected');
    assert.equal(result.challengeType, 'recaptcha');
    assert.ok(result.details?.includes('recaptcha'));
  });
});
