import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  fillAshbyForm,
  verifyRequiredFieldsCommitted,
} from '../src/submitter/ashbyFormFiller.js';
import { scrapeLiveFieldFromDom } from '../src/submitter/realtimeDomAction.js';

describe('Ashby Radio Peer & Consent Handling', () => {
  let browser: Browser;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterEach(async () => {
    await browser?.close();
  });

  it('checks peer radio input when label is a sibling with a "for" attribute', async () => {
    const html = `
      <form>
        <div data-field-path="c43a40fa-cd71-48df-9f62-b4e35734432a" class="field-container">
          <label class="question-title">Will you now or in the future require visa sponsorship?</label>
          <div class="ashby-application-form-input-radio-group-option">
            <span><input type="radio" id="radio-no" name="sponsorship"></span>
            <label for="radio-no" class="ashby-application-form-input-radio-group-option-label">No</label>
          </div>
          <div class="ashby-application-form-input-radio-group-option">
            <span><input type="radio" id="radio-yes" name="sponsorship"></span>
            <label for="radio-yes" class="ashby-application-form-input-radio-group-option-label">Yes</label>
          </div>
        </div>
      </form>
    `;
    await page.setContent(html);

    const resolvedFields = [
      {
        fieldId: 'c43a40fa-cd71-48df-9f62-b4e35734432a',
        name: 'c43a40fa-cd71-48df-9f62-b4e35734432a',
        label: 'Will you now or in the future require visa sponsorship?',
        type: 'radio' as const,
        value: 'Yes',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, 'dummy-path.pdf');
    expect(result.filledCount).toBe(1);

    const isChecked = await page.locator('input#radio-yes').isChecked();
    expect(isChecked).toBe(true);

    const verification = await verifyRequiredFieldsCommitted(page, ['c43a40fa-cd71-48df-9f62-b4e35734432a']);
    expect(verification.allCommitted).toBe(true);
    expect(verification.missingFields).toHaveLength(0);
  });

  it('does not reject telephone input container when nested consent radios are unselected', async () => {
    const html = `
      <form>
        <div data-field-path="d9496711-3634-4aca-876d-31e0b94a1cd5" class="field-container">
          <label for="phone-input">Phone Number</label>
          <input type="tel" id="phone-input" name="phone" value="(573) 419-4234" required>
          <div class="consent-radios">
            <input type="radio" name="smsConsent" value="given"> Yes
            <input type="radio" name="smsConsent" value="notGiven"> No
          </div>
        </div>
      </form>
    `;
    await page.setContent(html);

    const verification = await verifyRequiredFieldsCommitted(page, ['d9496711-3634-4aca-876d-31e0b94a1cd5']);
    expect(verification.allCommitted).toBe(true);
    expect(verification.missingFields).toHaveLength(0);
  });

  it('locates live DOM container directly by data-field-path', async () => {
    const html = `
      <form>
        <div data-field-path="_systemfield_location" class="field-container">
          <label class="ashby-application-form-question-title">In which city and state do you reside?</label>
          <input class="ashby-application-form-input-autocomplete" placeholder="Start typing..." role="combobox" value="">
        </div>
      </form>
    `;
    await page.setContent(html);

    const scraped = await scrapeLiveFieldFromDom(page, '_systemfield_location');
    expect(scraped).not.toBeNull();
    expect(scraped?.found).toBe(true);
    expect(scraped?.containerSelector).toBe('[data-field-path="_systemfield_location"]');
  });
});
