import { chromium } from 'playwright';
import { PlaywrightScanner } from '../../../src/scanner/playwrightScanner.ts';

const jobUrl = 'https://wmenergy.com/careers/position/5281483007?gh_jid=5281483007';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const template = await new PlaywrightScanner({ timeoutMs: 30_000 }).scanSingleUrl(jobUrl, page);
  const gedFields = template.fields.filter((field) => /GED/i.test(`${field.label} ${field.name}`));
  const pageState = await page.evaluate(() => ({
    currentUrl: location.href,
    title: document.title,
    text: document.body?.innerText.slice(0, 1_000) ?? '',
    frameUrls: Array.from(document.querySelectorAll('iframe'), (frame) => frame.src),
  }));
  console.log(JSON.stringify({
    requestedUrl: jobUrl,
    scannedUrl: template.jobUrl,
    pageState,
    isExpired: template.isExpired,
    fieldCount: template.fields.length,
    gedFields: gedFields.map(({ label, name, isRequired, type }) => ({ label, name, isRequired, type })),
    submitted: false,
  }, null, 2));
} finally {
  await browser.close();
}
