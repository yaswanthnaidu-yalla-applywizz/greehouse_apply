import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { waitForAshbyApplicationReady } from '../src/submitter/ashbySubmit.js';

test('waits for an Ashby field container to appear after initial page content', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main>Loading</main>');
    const readiness = waitForAshbyApplicationReady(page, 500);
    await page.waitForTimeout(25);
    await page.locator('main').evaluate((main) => {
      main.innerHTML = '<div data-field-path="name"><label>Name<input /></label></div>';
    });
    assert.equal(await page.locator('[data-field-path]').count(), 1);

    await readiness;
    assert.equal(await page.locator('[data-field-path]').count(), 1);
  } finally {
    await browser.close();
  }
});

test('fails closed when the page never exposes an Ashby field container', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main>Careers landing page</main>');

    await assert.rejects(waitForAshbyApplicationReady(page, 50), /Ashby application form readiness timed out/i);
  } finally {
    await browser.close();
  }
});
