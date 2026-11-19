import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fillRipplingForm } from '../src/submitter/ripplingFormFiller.js';
import { extractRipplingFieldsFromPage } from '../src/scanner/ripplingScanner.js';
import type { ResolvedField } from '../src/types/index.js';

let browser: Browser;
let page: Page;
let resumePath: string;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  resumePath = path.join(os.tmpdir(), `rippling-resume-${process.pid}.pdf`);
  await fs.writeFile(resumePath, '%PDF fixture');
});
test.after(async () => {
  await browser.close();
  await fs.rm(resumePath, { force: true });
});

const field = (fieldId: string, label: string, type: string, value: string, isRequired = true): ResolvedField => ({
  fieldId, name: fieldId, label, type, value, isRequired, source: 'tier1', resolvedByTier: 1, confidence: 1,
});

test('uses upload and parse confirmations even when the file input clears, then fills text fields', async () => {
  await page.setContent(`<form>
    <label for="resume">Resume <b aria-hidden="true">*</b></label><input id="resume" name="resume" type="file" required>
    <label for="full_name">Full name <b aria-hidden="true">*</b></label><input id="full_name" name="full_name" required>
  </form>`);
  await page.evaluate((filename) => {
    const resume = document.querySelector<HTMLInputElement>('#resume')!;
    resume.addEventListener('change', () => setTimeout(() => {
      document.querySelector<HTMLInputElement>('#full_name')!.value = 'Parsed Name';
      document.querySelector<HTMLInputElement>('#full_name')!.dispatchEvent(new Event('input', { bubbles: true }));
      const status = document.createElement('div');
      status.textContent = 'File ' + filename + ' uploaded successfully';
      document.body.append(status);
      const parsed = document.createElement('div');
      parsed.textContent = 'Résumé parsing was successful.';
      document.body.append(parsed);
      Object.defineProperty(resume, 'files', { configurable: true, get: () => [] });
      document.body.dataset.resumeParsed = 'true';
    }, 30));
  }, path.basename(resumePath));
  const fields = [field('session-id-42', 'Full name', 'text', 'Ada Lovelace'), field('fresh-id-91', 'Resume', 'file', '')];
  fields[0].name = 'field-from-another-session';
  fields[1].name = 'different-file-name';
  const result = await fillRipplingForm(page, fields, resumePath);
  assert.equal(result.filledCount, 2);
  assert.equal(await page.locator('#full_name').inputValue(), 'Ada Lovelace');
  assert.equal(await page.getByText(/File rippling-resume-.* uploaded successfully/).isVisible(), true);
  assert.equal(await page.getByText(/parsing was successful/).isVisible(), true);
});

test('fails closed for unresolved required fields and unsupported required controls', async () => {
  await page.setContent('<form><label for="name">Name</label><input id="name" required></form>');
  await assert.rejects(fillRipplingForm(page, [field('missing', 'Missing', 'text', '')], resumePath), /required.*(?:unresolved|field)/i);
  await assert.rejects(fillRipplingForm(page, [field('name', 'Name', 'select', 'Somewhere')], resumePath), /unsupported|required/i);
});

test('validates committed required text values after filling', async () => {
  await page.setContent('<form><label for="email">Email</label><input id="email" required></form>');
  await page.locator('#email').evaluate((input) => input.addEventListener('input', () => { (input as HTMLInputElement).value = ''; }));
  await assert.rejects(fillRipplingForm(page, [field('email', 'Email', 'text', 'ada@example.com')], resumePath), /required.*(?:commit|value)|not committed/i);
});

test('selects exact required phone country and location autocomplete options', async () => {
  await page.setContent(`<form>
    <label for="country-input">Phone country</label><input id="country-input" role="combobox" aria-label="Phone country" aria-expanded="false">
    <div role="listbox"></div>
    <label for="location-input">Current location</label><input id="location-input" role="textbox" aria-label="Current location" aria-autocomplete="list">
    <div role="listbox"></div>
  </form>`);
  await page.evaluate(() => {
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[role="combobox"], [aria-autocomplete="list"]'))) {
      input.addEventListener('input', () => {
        document.querySelectorAll('[role="option"]').forEach((option) => option.remove());
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = input.value;
        option.addEventListener('click', () => { input.setAttribute('aria-expanded', 'false'); });
        input.parentElement!.append(option);
      });
    }
  });
  const fields = [field('unstable-phone', 'Phone country', 'select', 'United States'), field('unstable-location', 'Current location', 'text', 'San Francisco, CA')];
  await fillRipplingForm(page, fields, resumePath);
  assert.equal(await page.locator('#country-input').inputValue(), 'United States');
  assert.equal(await page.locator('#location-input').inputValue(), 'San Francisco, CA');
});

test('fails when a stable label matches multiple controls', async () => {
  await page.setContent('<form><label for="one">Email</label><input id="one"><label for="two">Email</label><input id="two"></form>');
  await assert.rejects(fillRipplingForm(page, [field('random', 'Email', 'text', 'a@b.com')], resumePath), /ambiguous/i);
});

test('fills phone country and location fields using the scanner output shape', async () => {
  await page.setContent(`<form>
    <div data-testid="phone_number-code"><span>Phone number</span><input id="country-search" role="combobox" aria-label="Search" aria-expanded="false" aria-required="true"></div>
    <div data-testid="field"><div id="location-label">Current location <span>*</span></div><input id="location-search" role="textbox" aria-label="Search" aria-labelledby="location-label" aria-autocomplete="list" aria-required="true"></div>
  </form>`);
  await page.evaluate(() => {
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('[role="combobox"], [aria-autocomplete="list"]'))) {
      input.addEventListener('input', () => {
        document.querySelectorAll('[role="option"]').forEach((option) => option.remove());
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = input.id === 'country-search' ? 'United States' : 'San Francisco, CA';
        input.parentElement!.append(option);
      });
    }
  });
  const scanned = await extractRipplingFieldsFromPage(page, 'https://ats.rippling.com/company/jobs/fixture/apply');
  const resolved = scanned.fields.map((scannedField) => ({ ...scannedField, value: scannedField.label === 'Phone country code' ? 'United States' : 'San Francisco, CA', source: 'tier1' as const, resolvedByTier: 1 as const, confidence: 1 }));
  assert.deepEqual(scanned.fields.map((item) => ({ label: item.label, type: item.type, isRequired: item.isRequired })), [
    { label: 'Phone country code', type: 'select', isRequired: true },
    { label: 'Current location', type: 'text', isRequired: true },
  ]);
  await fillRipplingForm(page, resolved, resumePath);
  assert.equal(await page.locator('#country-search').inputValue(), 'United States');
  assert.equal(await page.locator('#location-search').inputValue(), 'San Francisco, CA');
});

test('stops immediately on a visible human verification challenge', async () => {
  await page.setContent('<form><label for="name">Name</label><input id="name"></form><div>Verify you are human</div>');
  await assert.rejects(fillRipplingForm(page, [field('name', 'Name', 'text', 'Ada')], resumePath), /human verification challenge/i);
  assert.equal(await page.locator('#name').inputValue(), '');
});

test('ignores hidden verification copy and fills the form', async () => {
  await page.setContent('<form><label for="name">Name</label><input id="name"></form><div style="display:none">Verify you are human</div>');
  const result = await fillRipplingForm(page, [field('name', 'Name', 'text', 'Ada')], resumePath);
  assert.equal(result.filledCount, 1);
  assert.equal(await page.locator('#name').inputValue(), 'Ada');
});

test('ignores a visible passive verification widget and fills the form', async () => {
  await page.setContent('<form><label for="name">Name</label><input id="name"></form><iframe title="hCaptcha" src="https://newassets.hcaptcha.com/widget" srcdoc="<body>I am not a robot</body>" style="width:300px;height:80px"></iframe>');
  const result = await fillRipplingForm(page, [field('name', 'Name', 'text', 'Ada')], resumePath);
  assert.equal(result.filledCount, 1);
  assert.equal(await page.locator('#name').inputValue(), 'Ada');
});

test('commits the exact native SMS consent radio option', async () => {
  await page.setContent(`<form><fieldset>
    <legend>SMS consent</legend>
    <label><input type="radio" name="sms" value="yes">Yes - I consent to receiving text messages</label>
    <label><input type="radio" name="sms" value="no">No - I do not consent to receiving text messages</label>
  </fieldset></form>`);
  await fillRipplingForm(page, [field('unstable-sms-id', 'SMS consent', 'radio', 'No - I do not consent to receiving text messages')], resumePath);
  assert.equal(await page.locator('input[name="sms"][value="yes"]').isChecked(), false);
  assert.equal(await page.locator('input[name="sms"][value="no"]').isChecked(), true);
});

test('commits exact native checkbox labels and ARIA radio options', async () => {
  await page.setContent(`<form>
    <fieldset><legend>Updates</legend><label><input type="checkbox" name="updates" value="email">Email updates</label></fieldset>
    <div role="group" aria-label="Benefits"><div role="checkbox" aria-checked="false" aria-label="Health plan" data-value="health">Health plan</div></div>
    <div role="radiogroup" aria-label="Work authorization">
      <div role="radio" aria-checked="false" aria-label="Yes">Yes</div>
      <div role="radio" aria-checked="false" aria-label="No">No</div>
    </div>
  </form>`);
  await page.getByRole('radio', { name: 'Yes', exact: true }).evaluate((yes) => {
    yes.addEventListener('click', () => {
      yes.setAttribute('aria-checked', 'true');
      yes.parentElement!.querySelector('[role="radio"][aria-label="No"]')!.setAttribute('aria-checked', 'false');
    });
  });
  await page.getByRole('checkbox', { name: 'Health plan', exact: true }).evaluate((checkbox) => {
    checkbox.addEventListener('click', () => checkbox.setAttribute('aria-checked', 'true'));
  });
  await fillRipplingForm(page, [
    field('random-checkbox', 'Updates', 'checkbox', 'Email updates'),
    field('random-aria-checkbox', 'Benefits', 'checkbox', 'Health plan'),
    field('random-radio', 'Work authorization', 'radio', 'Yes'),
  ], resumePath);
  assert.equal(await page.locator('input[name="updates"]').isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: 'Health plan', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: 'Yes', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('radio', { name: 'No', exact: true }).getAttribute('aria-checked'), 'false');
});

test('fails closed when a required radio answer is missing or ambiguous', async () => {
  await page.setContent(`<form><fieldset><legend>SMS consent</legend>
    <label><input type="radio" name="sms" value="yes">Yes</label>
    <label><input type="radio" name="sms" value="no">No</label>
  </fieldset></form>`);
  await assert.rejects(fillRipplingForm(page, [field('sms', 'SMS consent', 'radio', 'Maybe')], resumePath), /exact|option|unsupported/i);
  await page.setContent(`<form><fieldset><legend>SMS consent</legend>
    <label><input type="radio" name="sms" value="yes">Yes</label>
    <label><input type="radio" name="sms" value="yes">Yes</label>
  </fieldset></form>`);
  await assert.rejects(fillRipplingForm(page, [field('sms', 'SMS consent', 'radio', 'Yes')], resumePath), /ambiguous/i);
});
