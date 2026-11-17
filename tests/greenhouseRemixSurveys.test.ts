import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { extractCustomDemographicSurveys } from '../src/scanner/playwrightScanner.js';
import { detectFormFillingErrors } from '../src/submitter/liveSubmit.js';

process.env.NODE_ENV = 'test';

describe('Greenhouse Custom Demographic Surveys & Hidden Invalid Inputs', () => {
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

  it('extracts custom demographic select fields from branded demographic containers', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div class="custom-demographic-section" data-qa="demographic-survey">
          <h3>Demographic Survey</h3>
          <div class="field">
            <label for="custom_gender">Gender Identity *</label>
            <select id="custom_gender" name="custom_gender" required>
              <option value="">Select...</option>
              <option value="man">Man</option>
              <option value="woman">Woman</option>
              <option value="non_binary">Non-Binary</option>
              <option value="decline">I prefer not to say</option>
            </select>
          </div>
          <div class="field">
            <label for="custom_race">Race / Ethnicity *</label>
            <select id="custom_race" name="custom_race" required>
              <option value="">Select...</option>
              <option value="asian">Asian</option>
              <option value="white">White</option>
              <option value="decline">Decline to state</option>
            </select>
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const surveyed = await extractCustomDemographicSurveys(page);
    assert.equal(surveyed.length, 2, 'Must extract both custom demographic fields');

    const genderField = surveyed.find((f) => f.name === 'custom_gender');
    assert.ok(genderField);
    assert.equal(genderField.isRequired, true);
    assert.equal(genderField.type, 'select');
    assert.deepEqual(genderField.options, ['Man', 'Woman', 'Non-Binary', 'I prefer not to say']);
  });

  it('detectFormFillingErrors catches hidden invalid combobox inputs with class requiredInput', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <form id="app_form">
          <div class="field">
            <label id="school-label">School *</label>
            <div class="select-wrapper">
              <!-- Greenhouse Remix React-Select hidden backing input -->
              <input
                class="requiredInput"
                tabindex="-1"
                aria-hidden="true"
                required
                value=""
                name="school_backing"
              />
            </div>
          </div>
        </form>
      </body>
      </html>
    `;
    await page.setContent(html);

    const errorResult = await detectFormFillingErrors(page);
    assert.equal(errorResult.hasError, true, 'Must detect invalid input.requiredInput despite tabindex="-1" and aria-hidden');
    assert.match(
      errorResult.message || '',
      /School|school_backing/i,
      'Error message must indicate School field'
    );
  });
});
