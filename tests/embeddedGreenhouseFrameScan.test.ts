import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { PlaywrightScanner, waitForEmbeddedGreenhouseApplicationUrl } from '../src/scanner/playwrightScanner.ts';

const embeddedUrl = 'https://boards.greenhouse.io/embed/job_app?for=walker-miller&token=5281483007';

test('returns an immediately available Greenhouse application frame URL', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://boards.greenhouse.io/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.setContent(`<iframe src="${embeddedUrl}"></iframe>`);
    assert.equal(await waitForEmbeddedGreenhouseApplicationUrl(page, 1000), embeddedUrl);
  } finally {
    await browser.close();
  }
});

test('waits for a delayed Greenhouse application frame', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://boards.greenhouse.io/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.setContent(`<form><input name="newsletter"></form><script>setTimeout(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(embeddedUrl)}; document.body.append(frame); }, 150)</script>`);
    assert.equal(await waitForEmbeddedGreenhouseApplicationUrl(page, 1000), embeddedUrl);
  } finally {
    await browser.close();
  }
});

test('returns null without a Greenhouse frame and preserves parent form expiry behavior', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://wmenergy.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<form><input name="newsletter"></form>' }));
    await page.goto('https://wmenergy.test/careers/position/5281483007', { waitUntil: 'domcontentloaded' });
    assert.equal(await waitForEmbeddedGreenhouseApplicationUrl(page, 100), null);
    const template = await new PlaywrightScanner({ timeoutMs: 1000 }).scanSingleUrl('https://wmenergy.test/careers/position/5281483007', page);
    assert.equal(template.isExpired, true);
  } finally {
    await browser.close();
  }
});

test('scans the embedded application when its frame appears after DOMContentLoaded', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://wmenergy.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<form><input name="newsletter"></form><script>setTimeout(() => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(embeddedUrl)}; document.body.append(frame); }, 150)</script>` }));
    await page.route('https://boards.greenhouse.io/**', (route) => route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Walker-Miller Energy Services</h1><form id="application_form"><label for="ged">GED Question*</label><input id="ged" name="job_application[answers_attributes][0][text_value]" required><button type="submit">Submit Application</button></form></body></html>' }));
    const template = await new PlaywrightScanner({ timeoutMs: 1000 }).scanSingleUrl('https://wmenergy.test/careers/position/5281483007', page);
    assert.equal(template.jobUrl, embeddedUrl);
    assert.equal(template.isExpired, false);
    assert.ok(template.fields.some((field) => /GED Question/i.test(field.label)));
  } finally {
    await browser.close();
  }
});

test('does not poll for embedded frames on a direct Greenhouse job page', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://boards.greenhouse.io/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<html><body><h1>Walker-Miller Energy Services</h1><form id="application_form"><label for="name">Name</label><input id="name" name="name"><button type="submit">Submit Application</button></form></body></html>',
    }));
    let waitCalls = 0;
    const waitForTimeout = page.waitForTimeout.bind(page);
    page.waitForTimeout = async (timeout) => {
      waitCalls++;
      await waitForTimeout(timeout);
    };

    const template = await new PlaywrightScanner({ timeoutMs: 1000 }).scanSingleUrl(
      'https://boards.greenhouse.io/walker-miller/jobs/5281483007',
      page,
    );

    assert.equal(template.isExpired, false);
    assert.equal(waitCalls, 0);
  } finally {
    await browser.close();
  }
});
