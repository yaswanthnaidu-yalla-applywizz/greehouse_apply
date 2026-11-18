import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerificationResource } from '../src/submitter/atsVerification.js';
import { STANDARD_CHROMIUM_ARGS } from '../src/submitter/browserManager.js';

test('Task 5: Page Dependency Route Whitelisting & Runtime Launch Args', async (t) => {
  await t.test('isVerificationResource identifies anti-bot verification CDNs and endpoints', () => {
    // Cloudflare Turnstile
    assert.strictEqual(
      isVerificationResource('https://challenges.cloudflare.com/turnstile/v0/api.js'),
      true
    );
    assert.strictEqual(
      isVerificationResource('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
      true
    );

    // hCaptcha
    assert.strictEqual(
      isVerificationResource('https://js.hcaptcha.com/1/api.js'),
      true
    );
    assert.strictEqual(
      isVerificationResource('https://newassets.hcaptcha.com/c/349f7b1/hcaptcha.js'),
      true
    );
    assert.strictEqual(
      isVerificationResource('https://api2.hcaptcha.com/checksiteconfig'),
      true
    );

    // Google reCAPTCHA
    assert.strictEqual(
      isVerificationResource('https://www.google.com/recaptcha/api.js'),
      true
    );
    assert.strictEqual(
      isVerificationResource('https://www.gstatic.com/recaptcha/releases/123/recaptcha__en.js'),
      true
    );
    assert.strictEqual(
      isVerificationResource('https://recaptcha.net/recaptcha/api.js'),
      true
    );

    // Non-verification ATS endpoints
    assert.strictEqual(
      isVerificationResource('https://jobs.lever.co/company/job-id/apply'),
      false
    );
    assert.strictEqual(
      isVerificationResource('https://jobs.ashbyhq.com/company/job-id/application'),
      false
    );
    assert.strictEqual(
      isVerificationResource('https://api.lever.co/v0/postings/company/job-id/apply'),
      false
    );
  });

  await t.test('route interception allows verification resources even when POST /apply pattern matches', async () => {
    const interceptedUrls: string[] = [];
    const abortedUrls: string[] = [];
    const continuedUrls: string[] = [];

    // Mock route handler logic
    const handleRoute = (url: string, method: string) => {
      interceptedUrls.push(url);
      const isPostApply = (url.includes('/postings/') && url.endsWith('/apply')) || url.endsWith('/apply');
      if (isVerificationResource(url)) {
        continuedUrls.push(url);
        return 'continue';
      }
      if (isPostApply && method === 'POST') {
        abortedUrls.push(url);
        return 'abort';
      }
      continuedUrls.push(url);
      return 'continue';
    };

    // 1. Live employer submission must be aborted
    const employerPost = handleRoute('https://jobs.lever.co/initech/123-abc/apply', 'POST');
    assert.strictEqual(employerPost, 'abort');
    assert.strictEqual(abortedUrls.includes('https://jobs.lever.co/initech/123-abc/apply'), true);

    // 2. Verification scripts must be allowed
    const turnstileScript = handleRoute('https://challenges.cloudflare.com/turnstile/v0/api.js', 'GET');
    assert.strictEqual(turnstileScript, 'continue');
    assert.strictEqual(continuedUrls.includes('https://challenges.cloudflare.com/turnstile/v0/api.js'), true);

    // 3. Verification challenge token post must be allowed
    const hcaptchaSiteverify = handleRoute('https://api2.hcaptcha.com/checksiteconfig', 'POST');
    assert.strictEqual(hcaptchaSiteverify, 'continue');
    assert.strictEqual(continuedUrls.includes('https://api2.hcaptcha.com/checksiteconfig'), true);
  });

  await t.test('STANDARD_CHROMIUM_ARGS includes anti-bot and container safety flags', () => {
    assert.ok(STANDARD_CHROMIUM_ARGS.includes('--disable-blink-features=AutomationControlled'));
    assert.ok(STANDARD_CHROMIUM_ARGS.includes('--no-sandbox'));
    assert.ok(STANDARD_CHROMIUM_ARGS.includes('--disable-dev-shm-usage'));
  });
});
