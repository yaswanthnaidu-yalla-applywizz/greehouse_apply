import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import {
  scrapeLiveFieldFromDom,
  commitRemediatedValue,
  type ScrapedDomField,
} from '../src/submitter/realtimeDomAction.js';
import type { RemediationDecision } from '../src/submitter/realtimeRemediator.js';

describe('Realtime DOM Action & Scraping', () => {
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

  it('scrapes standard select options and commits a selected option', async () => {
    await page.setContent(`
      <form id="app_form">
        <div class="field">
          <label for="work_auth">Are you legally authorized to work in the United States?</label>
          <select id="work_auth" name="work_auth">
            <option value="">-- Please select --</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </div>
      </form>
    `);

    const scraped = await scrapeLiveFieldFromDom(page, 'Are you legally authorized to work in the United States?');
    assert.ok(scraped, 'Field should be scraped');
    assert.equal(scraped.type, 'select');
    assert.deepEqual(scraped.options, ['Yes', 'No']);

    const decision: RemediationDecision = {
      fieldId: 'work_auth',
      value: 'Yes',
      chosenOptionLabel: 'Yes',
      confidence: 0.95,
      reasoning: 'US citizen',
      source: 'ai_realtime_remediated',
    };

    const commitResult = await commitRemediatedValue(page, scraped, decision);
    assert.ok(commitResult.success, 'Commit should succeed');
    assert.equal(commitResult.committedValue, 'Yes');

    // Verify DOM value in browser
    const selectedText = await page.$eval('#work_auth', (el: HTMLSelectElement) => el.options[el.selectedIndex]?.text);
    assert.equal(selectedText, 'Yes');
  });

  it('scrapes radio options and commits by clicking radio button label', async () => {
    await page.setContent(`
      <form id="app_form">
        <fieldset class="field">
          <legend>Will you require visa sponsorship?</legend>
          <label>
            <input type="radio" name="sponsorship" value="true">
            Yes, I require sponsorship
          </label>
          <label>
            <input type="radio" name="sponsorship" value="false">
            No, I do not require sponsorship
          </label>
        </fieldset>
      </form>
    `);

    const scraped = await scrapeLiveFieldFromDom(page, 'Will you require visa sponsorship?');
    assert.ok(scraped, 'Radio group should be scraped');
    assert.equal(scraped.type, 'radio');
    assert.deepEqual(scraped.options, ['Yes, I require sponsorship', 'No, I do not require sponsorship']);

    const decision: RemediationDecision = {
      fieldId: 'sponsorship',
      value: 'No, I do not require sponsorship',
      chosenOptionLabel: 'No, I do not require sponsorship',
      confidence: 0.98,
      reasoning: 'No sponsorship',
      source: 'ai_realtime_remediated',
    };

    const commitResult = await commitRemediatedValue(page, scraped, decision);
    assert.ok(commitResult.success, 'Radio commit should succeed');

    // Verify radio checked in DOM
    const isChecked = await page.$eval('input[value="false"]', (el: HTMLInputElement) => el.checked);
    assert.equal(isChecked, true);
  });

  it('scrapes text input and commits filled text', async () => {
    await page.setContent(`
      <form id="app_form">
        <div class="field">
          <label for="portfolio_url">Personal Website or Portfolio</label>
          <input type="text" id="portfolio_url" name="portfolio_url" value="">
        </div>
      </form>
    `);

    const scraped = await scrapeLiveFieldFromDom(page, 'Personal Website or Portfolio');
    assert.ok(scraped, 'Text input should be scraped');
    assert.equal(scraped.type, 'text');

    const decision: RemediationDecision = {
      fieldId: 'portfolio_url',
      value: 'https://janedoe.dev',
      confidence: 0.9,
      reasoning: 'From profile',
      source: 'ai_realtime_remediated',
    };

    const commitResult = await commitRemediatedValue(page, scraped, decision);
    assert.ok(commitResult.success);
    assert.equal(commitResult.committedValue, 'https://janedoe.dev');

    const domVal = await page.$eval('#portfolio_url', (el: HTMLInputElement) => el.value);
    assert.equal(domVal, 'https://janedoe.dev');
  });
});
