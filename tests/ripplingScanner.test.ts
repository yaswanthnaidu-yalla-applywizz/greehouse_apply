import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { extractRipplingFieldsFromPage } from '../src/scanner/ripplingScanner.js';

let browser: Browser;
let page: Page;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

test.after(async () => {
  await browser.close();
});

test('extracts labels, required signals, visible markers, and native options', async () => {
  await page.setContent(`<html><head><title>Engineer | Rippling</title></head><body>
    <form>
      <label for="name">Full name <span aria-hidden="true">*</span></label>
      <input id="name" name="candidate_name" type="text" aria-required="true">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <label for="country">Country</label><select id="country" name="country" required>
        <option value="">Select one</option><option value="us">United States</option>
      </select>
      <fieldset><legend>Work authorization <span class="required">Required</span></legend>
        <label><input type="radio" name="auth" value="yes">Yes</label>
        <label><input type="radio" name="auth" value="no">No</label>
      </fieldset>
      <label for="hidden">Hidden</label><input id="hidden" name="hidden" type="text" hidden>
    </form>
  </body></html>`);

  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/1');
  assert.equal(result.isExpired, false);
  assert.deepEqual(result.fields.map(({ name, label, type, isRequired, options }) => ({ name, label, type, isRequired, options })), [
    { name: 'candidate_name', label: 'Full name', type: 'text', isRequired: true, options: undefined },
    { name: 'email', label: 'Email', type: 'text', isRequired: false, options: undefined },
    { name: 'country', label: 'Country', type: 'select', isRequired: true, options: ['Select one', 'United States'] },
    { name: 'auth', label: 'Work authorization', type: 'radio', isRequired: true, options: ['Yes', 'No'] },
  ]);
});

test('marks unknown custom option lists incomplete', async () => {
  await page.setContent(`<html><body><form><div role="group" aria-label="Location" aria-required="true">
    <button type="button" role="combobox">Choose location</button>
  </div></form></body></html>`);
  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/2');
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].isRequired, true);
  assert.equal(result.fields[0].optionsComplete, false);
});

test('does not treat an inactive Turnstile mount as a challenge and reads upload and ARIA labels', async () => {
  await page.setContent(`<html><head><title>Agility Engineer | Rippling</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head><body>
    <div id="turnstile-container"></div>
    <form>
      <div class="field-wrapper" data-testid="application-field">
        <span id="resume-label">Resume <b aria-hidden="true">*</b></span>
        <button type="button">Upload resume</button>
        <input id="resume" name="resume" type="file" aria-labelledby="resume-label" required style="display:none">
      </div>
      <div class="field-wrapper" data-testid="application-field">
        <label id="location-label">Current location <span aria-hidden="true">*</span></label>
        <input id="location" name="location" type="text" aria-label="Search" aria-labelledby="location-label" required>
      </div>
    </form>
  </body></html>`);

  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/agility/1');
  assert.deepEqual(result.fields.map(({ fieldId, name, label, type, isRequired }) => ({ fieldId, name, label, type, isRequired })), [
    { fieldId: 'resume', name: 'resume', label: 'Resume', type: 'file', isRequired: true },
    { fieldId: 'location', name: 'location', label: 'Current location', type: 'text', isRequired: true },
  ]);
});

test('fails closed when a required control has no stable identity or label', async () => {
  await page.setContent('<html><body><form><div class="field-wrapper"><input required></div></form></body></html>');
  await assert.rejects(extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/required'), /required.*identity/i);
});

test('extracts live-shaped required upload, custom selects, and SMS radios from their field labels', async () => {
  await page.setContent(`<html><body><form>
    <div data-testid="field">
      <span id="field-resume-label">Résumé</span><span>*</span>
      <label data-testid="resume"><button type="button">Upload résumé</button><input type="file" name="resume" required style="display:none"></label>
    </div>
    <div data-testid="field"><span id="field-country-label">What country are you authorized to work in?</span><span>*</span>
      <div role="combobox" aria-label="Select" tabindex="0">Select</div>
    </div>
    <div data-testid="field"><span id="field-visa-label">Do you require sponsorship?</span><span>*</span>
      <div role="combobox" aria-label="Select" tabindex="0">Select</div>
    </div>
    <div data-testid="field"><span id="field-sms-label">May we contact you by SMS?</span><span>*</span>
      <div role="radiogroup"><div role="radio" aria-checked="false"><input name="sms_opt_in" aria-hidden="true" tabindex="-1">No</div>
      <div role="radio" aria-checked="true"><input name="sms_opt_in" aria-hidden="true" tabindex="-1">Yes</div></div>
    </div>
  </form></body></html>`);

  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/agility/live-shaped');
  assert.deepEqual(result.fields.map(({ fieldId, name, label, type, isRequired, options }) => ({ fieldId, name, label, type, isRequired, options })), [
    { fieldId: 'resume', name: 'resume', label: 'Résumé', type: 'file', isRequired: true, options: undefined },
    { fieldId: 'field-country-label', name: 'field-country-label', label: 'What country are you authorized to work in?', type: 'select', isRequired: true, options: [] },
    { fieldId: 'field-visa-label', name: 'field-visa-label', label: 'Do you require sponsorship?', type: 'select', isRequired: true, options: [] },
    { fieldId: 'sms_opt_in', name: 'sms_opt_in', label: 'May we contact you by SMS?', type: 'radio', isRequired: true, options: ['No', 'Yes'] },
  ]);
});

test('identifies the Rippling phone country code control from its data-testid context', async () => {
  await page.setContent(`<html><body><form><div data-testid="field">
    <span id="phone-label">Phone number</span><span>*</span>
    <input type="tel" name="input-phone_number" aria-labelledby="phone-label" required>
    <div data-testid="phone_number-code"><input role="combobox" aria-label="Search" required></div>
  </div></form></body></html>`);
  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/phone');
  assert.deepEqual(result.fields.map(({ fieldId, label, type, isRequired, optionsComplete, metadata }) => ({ fieldId, label, type, isRequired, optionsComplete, metadata })), [
    { fieldId: 'input-phone_number', label: 'Phone number', type: 'text', isRequired: true, optionsComplete: undefined, metadata: undefined },
    { fieldId: 'phone_number-code', label: 'Phone country code', type: 'select', isRequired: true, optionsComplete: false, metadata: { selector: '[data-testid="phone_number-code"]' } },
  ]);
});

test('fails closed for gibberish required labels', async () => {
  await page.setContent('<html><body><form><label>xqzvwrltkjp</label><input name="salary" required></form></body></html>');
  await assert.rejects(extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/salary'), /label/i);
});

test('fails closed when a visible required marker has no captured control', async () => {
  await page.setContent(`<html><body><form><div data-testid="field">
    <span id="salary-label">Salary expectation</span><span>*</span><div data-testid="unrecognized-custom-control">Choose</div>
  </div></form></body></html>`);
  await assert.rejects(extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/unrecognized'), /required marker has no captured control/i);
});

test('keeps field identities unique across repeated Rippling field wrappers', async () => {
  await page.setContent(`<html><body><form>
    <div data-testid="field"><span id="field-first-name-label">First name</span><input name="first_name" required></div>
    <div data-testid="field"><span id="field-last-name-label">Last name</span><input name="last_name" required></div>
  </form></body></html>`);
  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/repeated-fields');
  const identities = result.fields.map((field) => field.fieldId);
  assert.equal(new Set(identities).size, identities.length);
  assert.deepEqual(identities, ['first_name', 'last_name']);
});

test('fails closed when a required wrapper contains only an unrelated captured input and unknown widget', async () => {
  await page.setContent(`<html><body><form><div data-testid="field">
    <span id="salary-label">Salary expectation</span><span>*</span>
    <input type="hidden" name="salary_backing">
    <input name="notes" aria-label="Internal notes">
    <div role="button" tabindex="0">Open salary editor</div>
  </div></form></body></html>`);
  await assert.rejects(extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/unknown-widget'), /unrecognized|required control/i);
});

test('returns expired only for an explicit closed posting', async () => {
  await page.setContent('<html><head><title>Closed role</title></head><body><h1>This job is no longer accepting applications</h1></body></html>');
  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/3');
  assert.equal(result.isExpired, true);
  assert.deepEqual(result.fields, []);
});

test('fails closed for a challenge page and an unexplained empty page', async () => {
  await page.setContent('<html><body><div class="cf-turnstile">Verify you are human</div></body></html>');
  await assert.rejects(extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/4'), /blocked/i);
  await page.setContent('<html><head><title>Engineer | Rippling</title></head><body><main></main></body></html>');
  await assert.rejects(extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/5'), /zero fields/i);
});

test('scans through hidden verification copy and a passive visible widget', async () => {
  await page.setContent(`<html><body><form>
    <label for="name">Full name</label><input id="name" required>
    <div style="display:none">Verify you are human</div>
    <iframe title="Cloudflare Turnstile" src="https://challenges.cloudflare.com/turnstile" srcdoc="<body>I am not a robot</body>" style="width:300px;height:65px"></iframe>
  </form></body></html>`);
  const result = await extractRipplingFieldsFromPage(page, 'https://jobs.rippling.com/example/passive-widget');
  assert.equal(result.isExpired, false);
  assert.equal(result.fields.length, 1);
});
