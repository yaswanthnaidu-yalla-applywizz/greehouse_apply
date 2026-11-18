import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { observeAtsVerification } from '../src/submitter/atsVerification.js';
import { fillLeverForm } from '../src/submitter/leverSubmit.js';

let browser: Browser;
let page: Page;
let externalRequests = 0;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith('about:')) return route.continue();
    externalRequests++;
    return route.abort();
  });
});

after(async () => {
  assert.equal(externalRequests, 0, 'local fixtures must not request an external host');
  await browser.close();
});

test('classifies a hidden provider frame as passive evidence', async () => {
  await page.setContent('<iframe title="hCaptcha" src="https://newassets.hcaptcha.com/widget" srcdoc="<body>Verify you are human</body>" style="display:none"></iframe>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'passive_widget', provider: 'hcaptcha' });
});

test('classifies a visible non-interactive verification frame as passive', async () => {
  await page.setContent('<iframe title="Cloudflare Turnstile" src="https://challenges.cloudflare.com/turnstile" srcdoc="<body>I am not a robot</body>" style="width:300px;height:65px"></iframe>');
  assert.deepEqual(await observeAtsVerification(page, 'lever'), { kind: 'passive_widget', provider: 'turnstile' });
});

test('keeps hidden verification copy passive', async () => {
  await page.setContent('<div style="display:none">Verify that you are human</div>');
  assert.deepEqual(await observeAtsVerification(page, 'rippling'), { kind: 'passive_widget', provider: 'unknown' });
});

test('detects a visible puzzle modal with provider attribution', async () => {
  await page.setContent('<div class="hcaptcha-box" style="width:350px;height:400px"><iframe title="hCaptcha puzzle" src="https://newassets.hcaptcha.com/puzzle" srcdoc="<body>Select all images with a train</body>" style="width:300px;height:350px"></iframe><div>Select all images with a train</div></div>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'interactive', provider: 'hcaptcha', evidence: 'puzzle' });
});

test('detects an explicit human prompt inside a provider frame', async () => {
  await page.setContent('<iframe title="Cloudflare security verification" src="https://challenges.cloudflare.com/verify" srcdoc="<body>Verify that you are human</body>" style="width:300px;height:80px"></iframe>');
  assert.deepEqual(await observeAtsVerification(page, 'rippling'), { kind: 'interactive', provider: 'turnstile', evidence: 'human_prompt' });
});

test('detects human verification evidence exposed through an accessible label', async () => {
  await page.setContent('<button aria-label="Verify that you are human">Continue</button>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'interactive', provider: 'unknown', evidence: 'human_prompt' });
});

test('returns a safe widget error code', async () => {
  await page.setContent('<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor" srcdoc="<body>ERROR: invalid-domain-for-site-key</body>" style="width:300px;height:80px"></iframe>');
  assert.deepEqual(await observeAtsVerification(page, 'lever'), { kind: 'widget_error', provider: 'recaptcha', code: 'INVALID_DOMAIN_FOR_SITE_KEY' });
});

test('does not treat job copy that mentions CAPTCHA as a gate', async () => {
  await page.setContent('<main><p>CAPTCHA may be required by the employer after application submission.</p></main>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'none' });
});

test('does not treat full challenge phrases in unrelated page copy as a gate', async () => {
  await page.setContent('<main><p>In this role, you will help verify that you are human interactions work properly across all client portals.</p></main>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'none' });
});

test('keeps verification copy hidden by opacity or clipping passive', async () => {
  await page.setContent('<div style="opacity:0">Verify that you are human</div>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'passive_widget', provider: 'unknown' });
  await page.setContent('<div style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">Verify that you are human</div>');
  assert.deepEqual(await observeAtsVerification(page, 'ashby'), { kind: 'passive_widget', provider: 'unknown' });
});

test('ignores an unrelated frame without verification markers', async () => {
  await page.setContent('<iframe title="Embedded content" srcdoc="<body>Video</body>" style="width:300px;height:200px"></iframe>');
  assert.deepEqual(await observeAtsVerification(page, 'rippling'), { kind: 'none' });
});

test('stops Lever filling when a puzzle appears during Current Location entry', async () => {
  await page.setContent(`<form id="application-form">
    <input class="location-input" name="location">
    <input id="selected-location" type="hidden">
    <div class="dropdown-location" style="display:none">San Jose, CA</div>
    <input name="cards[custom]">
  </form><button id="btn-submit" type="button">Apply</button>`);
  await page.evaluate(() => {
    const location = document.querySelector<HTMLInputElement>('.location-input')!;
    const suggestion = document.querySelector<HTMLElement>('.dropdown-location')!;
    location.addEventListener('input', () => { suggestion.style.display = 'block'; });
    suggestion.addEventListener('click', () => {
      document.querySelector<HTMLInputElement>('#selected-location')!.value = JSON.stringify({ name: 'San Jose, CA' });
      const puzzle = document.createElement('div');
      puzzle.className = 'hcaptcha-box';
      puzzle.style.cssText = 'width:300px;height:300px';
      puzzle.textContent = 'Select all images with a bus';
      document.body.append(puzzle);
    });
  });
  let applyClicked = false;
  await page.locator('#btn-submit').evaluate((button) => button.addEventListener('click', () => { button.setAttribute('data-clicked', 'true'); }));
  try {
    await fillLeverForm(page, { resolved_fields: [{ name: 'cards[custom]', type: 'text', value: 'answer' }] } as any, { first_name: 'Test', last_name: 'Candidate', location: 'San Jose, CA' } as any);
    applyClicked = true;
    await page.locator('#btn-submit').click();
  } catch (error) {
    assert.match(String(error), /human verification challenge/i);
  }
  assert.equal(await page.locator('input[name="cards[custom]"]').inputValue(), '');
  assert.equal(await page.locator('#btn-submit').getAttribute('data-clicked'), null);
  assert.equal(applyClicked, false);
});
