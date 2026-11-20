import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { scrapeLiveFieldFromDom, commitRemediatedValue } from '../src/submitter/realtimeDomAction.js';
import type { RemediationDecision } from '../src/submitter/realtimeRemediator.js';

describe('Realtime DOM Action Selector Isolation', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  });

  it('never targets input[type="file"] when committing a text decision on inputs without id/name', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="file-wrapper">
          <input type="file" tabindex="-1" accept=".pdf,.doc" />
        </div>
        <div class="field form-group">
          <label>In which city and state do you currently reside?</label>
          <input type="text" />
        </div>
      </body>
      </html>
    `;

    await page.setContent(html);

    const scraped = await scrapeLiveFieldFromDom(page, 'In which city and state do you currently reside?');
    expect(scraped).not.toBeNull();
    expect(scraped!.type).toBe('text');

    const decision: RemediationDecision = {
      fieldId: 'reside_city_state',
      value: 'Kansas City, Missouri',
      confidence: 0.95,
      reasoning: 'Verified profile address',
      issueFaced: 'Uncommitted location',
      issueFixed: 'Committed Kansas City, Missouri',
      source: 'ai_realtime_remediated',
    };

    const commitResult = await commitRemediatedValue(page, scraped!, decision);
    expect(commitResult.success).toBe(true);
    expect(commitResult.committedValue).toBe('Kansas City, Missouri');

    const textValue = await page.locator('input[type="text"]').inputValue();
    expect(textValue).toBe('Kansas City, Missouri');
  });

  it('scopes radio button selection to the target container without selecting earlier yes/no groups', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="field form-group" id="group-reloc">
          <label>Are you willing to relocate to Austin, TX?</label>
          <label><input type="radio" name="relocate_opt" value="Yes" /> Yes</label>
          <label><input type="radio" name="relocate_opt" value="No" /> No</label>
        </div>

        <div class="field form-group" id="group-spons">
          <label>Will you now or in the future require employment visa sponsorship?</label>
          <label><input type="radio" name="sponsorship_opt" value="No" /> No</label>
          <label><input type="radio" name="sponsorship_opt" value="Yes" /> Yes</label>
        </div>
      </body>
      </html>
    `;

    await page.setContent(html);

    // Scrape only the second question (Sponsorship)
    const scrapedSpons = await scrapeLiveFieldFromDom(
      page,
      'Will you now or in the future require employment visa sponsorship?'
    );
    expect(scrapedSpons).not.toBeNull();
    expect(scrapedSpons!.type).toBe('radio');

    const decision: RemediationDecision = {
      fieldId: 'sponsorship_opt',
      value: 'Yes',
      chosenOptionLabel: 'Yes',
      confidence: 0.95,
      reasoning: 'Candidate requires sponsorship',
      issueFaced: 'Uncommitted sponsorship',
      issueFixed: 'Selected Yes',
      source: 'ai_realtime_remediated',
    };

    const commitResult = await commitRemediatedValue(page, scrapedSpons!, decision);
    expect(commitResult.success).toBe(true);

    // The second group (sponsorship_opt) MUST be checked
    const sponsChecked = await page.locator('input[name="sponsorship_opt"][value="Yes"]').isChecked();
    expect(sponsChecked).toBe(true);

    // The first group (relocate_opt) MUST NOT be checked
    const relocChecked = await page.locator('input[name="relocate_opt"][value="Yes"]').isChecked();
    expect(relocChecked).toBe(false);
  });
});
