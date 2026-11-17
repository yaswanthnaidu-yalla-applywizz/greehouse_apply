import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  isEducationSectionRequiredOnDom,
  isExplicitEducationField,
  applyEducationDegreeFallback,
} from '../src/submitter/formFiller.js';
import type { ResolvedField } from '../src/types/index.js';

process.env.NODE_ENV = 'test';

describe('Greenhouse Education Section Requiredness & Retention Fix', () => {
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

  it('detects education requiredness when label text has whitespace before asterisk ("School *")', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label id="school-label">School *</label>
          <div id="school--0"></div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const isReq = await isEducationSectionRequiredOnDom(page);
    assert.equal(isReq, true, 'Must detect requiredness when whitespace precedes asterisk in "School *"');
  });

  it('detects education requiredness when label has child span for asterisk', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label>Degree <span class="asterisk">*</span></label>
          <div id="degree--0"></div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const isReq = await isEducationSectionRequiredOnDom(page);
    assert.equal(isReq, true, 'Must detect requiredness when asterisk is in a child span');
  });

  it('detects education requiredness when aria-required="true" is on input element', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label>Discipline</label>
          <input id="school--0" aria-required="true" />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const isReq = await isEducationSectionRequiredOnDom(page);
    assert.equal(isReq, true, 'Must detect requiredness from aria-required attribute');
  });

  it('returns false when no education container has required markings', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field">
          <label>School (optional)</label>
          <input id="school--0" />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const isReq = await isEducationSectionRequiredOnDom(page);
    assert.equal(isReq, false, 'Must evaluate to false when no required markings exist');
  });

  it('correctly identifies explicit education fields', () => {
    const field1: ResolvedField = {
      fieldId: 'school--0',
      name: 'school--0',
      label: 'School',
      value: 'San Jose State University',
      source: 'tier1',
      resolvedByTier: 'tier1',
      confidence: 0.9,
    };
    const field2: ResolvedField = {
      fieldId: 'degree--0',
      name: 'degree--0',
      label: 'Degree',
      value: "Master's Degree",
      source: 'tier1',
      resolvedByTier: 'tier1',
      confidence: 0.9,
    };
    const field3: ResolvedField = {
      fieldId: 'first_name',
      name: 'first_name',
      label: 'First Name',
      value: 'Jane',
      source: 'tier1',
      resolvedByTier: 'tier1',
      confidence: 0.9,
    };

    assert.equal(isExplicitEducationField(field1), true);
    assert.equal(isExplicitEducationField(field2), true);
    assert.equal(isExplicitEducationField(field3), false);
  });
});
