import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { detectRipplingPostClickOutcome } from '../src/submitter/ripplingOutcome.js';

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route('**/*', (route) => route.request().url().startsWith('about:') ? route.continue() : route.abort());
});

after(async () => {
  await browser.close();
});

test('classifies a visible interactive Cloudflare frame as a challenge', async () => {
  await page.setContent('<iframe title="Cloudflare verification" src="https://challenges.cloudflare.com/turnstile" srcdoc="<body>Verify you are human</body>" style="width:300px;height:80px"></iframe>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'challenge' });
});

test('does not classify a hidden Cloudflare frame as an active challenge', async () => {
  await page.setContent('<iframe title="Cloudflare Turnstile" src="https://challenges.cloudflare.com/turnstile" srcdoc="<body>Verify you are human</body>" style="display:none"></iframe>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'unconfirmed' });
});

test('does not infer success from a normal form or spinner text', async () => {
  await page.setContent('<form><input value="Candidate"><div role="status">Submitting...</div></form>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'unconfirmed' });
});

test('treats a visible passive verification widget as unconfirmed', async () => {
  await page.setContent('<iframe title="hCaptcha" src="https://newassets.hcaptcha.com/widget" srcdoc="<body>I am not a robot</body>" style="width:300px;height:80px"></iframe>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'unconfirmed' });
});

test('classifies an image puzzle in a provider frame as a challenge', async () => {
  await page.setContent('<iframe title="hCaptcha puzzle" src="https://newassets.hcaptcha.com/puzzle" srcdoc="<body>Select all images with a train</body>" style="width:300px;height:300px"></iframe>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'challenge' });
});

test('classifies visible human-verification text but ignores hidden copy', async () => {
  await page.setContent('<div>Verify you are human</div>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'challenge' });
  await page.setContent('<div style="display:none">Verify you are human</div>');
  assert.deepEqual(await detectRipplingPostClickOutcome(page), { status: 'unconfirmed' });
});
