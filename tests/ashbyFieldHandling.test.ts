import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { extractAshbyFieldsFromPage } from '../src/scanner/ashbyScanner.js';
import { fillAshbyForm, extractNumericValue } from '../src/submitter/ashbyFormFiller.js';
import { alignResolvedChoice } from '../src/resolver/answerResolver.js';
import type { ResolvedField } from '../src/types/index.js';

process.env.NODE_ENV = 'test';

describe('Ashby Field Handling (Phone Priority, Number Parsing, LinkedIn N/A)', () => {
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

  it('scans container with both input[type="tel"] and radio options as text/phone, not radio', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Job @ Example</title></head>
      <body>
        <div data-field-path="_systemfield_phone">
          <label>Phone Number *</label>
          <input type="tel" name="phone" />
          <div class="sms-consent">
            <label><input type="radio" name="sms" value="yes" /> Opt in to SMS</label>
            <label><input type="radio" name="sms" value="no" /> Opt out</label>
          </div>
        </div>
      </body>
      </html>
    `;

    await page.setContent(html);

    const result = await extractAshbyFieldsFromPage(page, 'https://jobs.ashbyhq.com/example/job', {
      skipNavigation: true,
      throwOnZeroFields: true,
    });
    const phoneField = result.fields.find((f) => f.fieldId === '_systemfield_phone');

    assert.ok(phoneField, 'Must find phone field');
    assert.equal(phoneField.type, 'text', 'Phone field with nested SMS radios must be classified as text, not radio');
  });

  it('extractNumericValue extracts integer 100000 from compensation range', () => {
    const raw = 'USD Yearly: 100k-130k, Hourly: 60-80';
    const extracted = extractNumericValue(raw);
    assert.equal(extracted, '100000', 'Must extract lower-bound integer 100000 from 100k notation');
  });

  it('extractNumericValue handles standard formatted numeric strings', () => {
    assert.equal(extractNumericValue('$125,000 / year'), '125000');
    assert.equal(extractNumericValue('5 years'), '5');
    assert.equal(extractNumericValue('85.5k'), '85500');
  });

  it('fills input[type="number"] by typing extracted numeric value instead of unparseable raw string', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="desired_salary">
          <label>Desired Salary (USD)</label>
          <input type="number" id="salary" />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'desired_salary',
        name: 'desired_salary',
        label: 'Desired Salary (USD)',
        type: 'text',
        value: 'USD Yearly: 100k-130k, Hourly: 60-80',
        isRequired: true,
      },
    ];

    await fillAshbyForm(page, resolvedFields, '');

    const val = await page.inputValue('#salary');
    assert.equal(val, '100000', 'Number input must receive extracted numeric digits 100000');
  });

  it('alignResolvedChoice strips "https://N/A" and "N/A" for LinkedIn and URL fields', () => {
    const field: ScannedField = {
      fieldId: '_systemfield_urls_LinkedIn',
      name: 'linkedin',
      label: 'LinkedIn Profile URL',
      type: 'text',
      isRequired: false,
    };

    const resolvedWithHttpsNA: ResolvedField = {
      fieldId: '_systemfield_urls_LinkedIn',
      value: 'https://N/A',
      confidence: 0.9,
      source: 'tier1',
      resolvedByTier: 'tier1',
    };

    const cleaned1 = alignResolvedChoice(field, resolvedWithHttpsNA);
    assert.equal(cleaned1.value, '', 'Must strip https://N/A to empty string');
    assert.equal(cleaned1.source, 'unresolved');

    const resolvedWithPlainNA: ResolvedField = {
      fieldId: '_systemfield_urls_LinkedIn',
      value: 'N/A',
      confidence: 0.9,
      source: 'tier1',
      resolvedByTier: 'tier1',
    };

    const cleaned2 = alignResolvedChoice(field, resolvedWithPlainNA);
    assert.equal(cleaned2.value, '', 'Must strip N/A to empty string');
    assert.equal(cleaned2.source, 'unresolved');
  });
});
