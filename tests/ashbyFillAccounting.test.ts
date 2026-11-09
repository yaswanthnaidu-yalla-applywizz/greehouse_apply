import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { fillAshbyForm, verifyRequiredFieldsCommitted } from '../src/submitter/ashbyFormFiller.js';
import type { ResolvedField } from '../src/types/index.js';
import { classifyRequiredFieldFailure } from '../src/utils/failureDiagnostics.js';

process.env.NODE_ENV = 'test';

describe('Ashby Form Fill Accounting & Pre-Submit Validation Gate', () => {
  it('classifies unresolved choices separately from controls that failed to commit', () => {
    assert.equal(classifyRequiredFieldFailure([
      { fieldId: 'country', source: 'unresolved', resolvedByTier: null },
    ], ['country']), 'RESOLUTION_CHOICE_MISMATCH');
    assert.equal(classifyRequiredFieldFailure([
      { fieldId: 'country', source: 'api', resolvedByTier: 4 },
    ], ['country']), 'CONTROL_NOT_COMMITTED');
  });

  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  });

  it('Test 1: unselected radio/select does NOT count as filled', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="work_auth">
          <label><input type="radio" name="work_auth" value="US Citizen"> US Citizen</label>
          <label><input type="radio" name="work_auth" value="Green Card"> Green Card</label>
        </div>
        <div data-field-path="gender_select">
          <select name="gender">
            <option value="">Select gender...</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
          </select>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'work_auth',
        name: 'work_auth',
        label: 'Work Authorization',
        value: 'NonExistentOption',
        type: 'radio',
        isRequired: true,
      },
      {
        fieldId: 'gender_select',
        name: 'gender_select',
        label: 'Gender',
        value: 'NonExistentChoice',
        type: 'select',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');

    // Unmatched/unselected elements must NOT be pushed to filledFields
    assert.equal(result.filledCount, 0, 'Expected 0 filled fields for unmatched radio/select');
    assert.equal(result.filledFields.length, 0);

    // Verify DOM inputs remain uncommitted
    const checkedRadio = await page.$('input[type="radio"]:checked');
    assert.equal(checkedRadio, null, 'No radio should be checked');
    const selectVal = await page.$eval('select', (el) => (el as HTMLSelectElement).value);
    assert.equal(selectVal, '', 'Select should have empty value');
  });

  it('Test 2: Yes/No button toggle is only counted when aria-pressed="true" or selected class is set', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <!-- Working toggle with button handler setting aria-pressed="true" -->
        <div data-field-path="sponsorship_needed">
          <div class="ashby-application-form-input-yesno">
            <button data-option="yes" onclick="this.setAttribute('aria-pressed', 'true'); this.classList.add('selected');">Yes</button>
            <button data-option="no" onclick="this.setAttribute('aria-pressed', 'true'); this.classList.add('selected');">No</button>
          </div>
        </div>

        <!-- Inert / Broken toggle that does not set aria-pressed or selected class on click -->
        <div data-field-path="relocate_toggle">
          <div class="ashby-application-form-input-yesno">
            <button data-option="yes">Yes</button>
            <button data-option="no">No</button>
          </div>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'sponsorship_needed',
        name: 'sponsorship_needed',
        label: 'Will you require sponsorship?',
        value: 'Yes',
        type: 'yes_no_toggle',
        isRequired: true,
      },
      {
        fieldId: 'relocate_toggle',
        name: 'relocate_toggle',
        label: 'Willing to relocate?',
        value: 'Yes',
        type: 'yes_no_toggle',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');

    // Working toggle should be counted, broken toggle should NOT be counted
    assert.equal(result.filledCount, 1);
    assert.equal(result.filledFields.length, 1);
    assert.equal(result.filledFields[0].fieldId, 'sponsorship_needed');
    assert.equal(result.filledFields[0].value, 'YES');
  });

  it('Test 3: Pre-submit check identifies missing required fields and verifies full DOM commitment', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="full_name">
          <input type="text" name="name" value="Jane Doe" required />
        </div>
        <div data-field-path="email_address">
          <input type="email" name="email" value="" required />
        </div>
        <div data-field-path="_systemfield_resume">
          <input type="file" name="resume" required />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const check1 = await verifyRequiredFieldsCommitted(page, [
      'full_name',
      'email_address',
      '_systemfield_resume',
    ]);

    assert.equal(check1.allCommitted, false);
    assert.ok(check1.missingFields.includes('email_address'));
    assert.ok(check1.missingFields.includes('_systemfield_resume'));
    assert.ok(!check1.missingFields.includes('full_name'));

    // Check pre-submit error format requirement:
    // `Pre-submit validation failed: Required field(s) uncommitted on DOM: ${missing.join(', ')}`
    const expectedErrorMsg = `Pre-submit validation failed: Required field(s) uncommitted on DOM: ${check1.missingFields.join(', ')}`;
    assert.match(expectedErrorMsg, /Pre-submit validation failed: Required field\(s\) uncommitted on DOM: email_address, _systemfield_resume/);

    // Now populate email and simulate resume preview chip (.ashby-file-preview)
    await page.$eval('input[name="email"]', (el) => {
      (el as HTMLInputElement).value = 'jane@example.com';
    });
    await page.$eval('div[data-field-path="_systemfield_resume"]', (el) => {
      const chip = document.createElement('div');
      chip.className = 'ashby-file-preview';
      chip.textContent = 'resume.pdf';
      el.appendChild(chip);
    });

    const check2 = await verifyRequiredFieldsCommitted(page, [
      'full_name',
      'email_address',
      '_systemfield_resume',
    ]);

    assert.equal(check2.allCommitted, true);
    assert.equal(check2.missingFields.length, 0);
  });

  it('Test 4: Checkbox matches desired state and verifies DOM commitment', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="consent_cb">
          <label><input type="checkbox" name="consent" /> I agree to terms</label>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'consent_cb',
        name: 'consent_cb',
        label: 'Terms Consent',
        value: 'true',
        type: 'checkbox',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');
    assert.equal(result.filledCount, 1);
    assert.equal(result.filledFields[0].value, 'Checked');

    const check = await verifyRequiredFieldsCommitted(page, ['consent_cb']);
    assert.equal(check.allCommitted, true);
  });

  it('fills only the exact option-valued checkbox and leaves unmatched values uncommitted', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="referral_source">
          <label><input type="checkbox" name="source" value="Referral" /> Referral</label>
          <label><input type="checkbox" name="source" value="Website" /> Website</label>
        </div>
        <div data-field-path="location_preferences">
          <label><input type="checkbox" name="location" value="Remote US" /> Remote US</label>
          <label><input type="checkbox" name="location" value="New York City Office" /> New York City Office</label>
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const result = await fillAshbyForm(page, [
      {
        fieldId: 'referral_source',
        name: 'referral_source',
        label: 'How did you hear about us?',
        value: 'Website',
        options: ['Referral', 'Website'],
        type: 'checkbox',
        isRequired: true,
      },
      {
        fieldId: 'location_preferences',
        name: 'location_preferences',
        label: 'Preferred locations',
        value: 'Florida, California',
        options: ['Remote US', 'New York City Office'],
        type: 'checkbox',
        isRequired: true,
      },
    ], '');

    assert.equal(await page.locator('[data-field-path="referral_source"] input[value="Website"]').isChecked(), true);
    assert.equal(await page.locator('[data-field-path="referral_source"] input[value="Referral"]').isChecked(), false);
    assert.equal(await page.locator('[data-field-path="location_preferences"] input:checked').count(), 0);
    assert.deepEqual(result.filledFields.map((field) => field.fieldId), ['referral_source']);
    assert.equal(result.filledCount, 1);

    const check = await verifyRequiredFieldsCommitted(page, ['referral_source', 'location_preferences']);
    assert.equal(check.allCommitted, false);
    assert.deepEqual(check.missingFields, ['location_preferences']);
  });

  it('Test 5: Live DOM state verification for standard text fields', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <body>
        <div data-field-path="phone_num">
          <input type="tel" name="phone" value="" />
        </div>
      </body>
      </html>
    `;
    await page.setContent(html);

    const resolvedFields: ResolvedField[] = [
      {
        fieldId: 'phone_num',
        name: 'phone_num',
        label: 'Phone Number',
        value: '+1 (555) 123-4567',
        type: 'text',
        isRequired: true,
      },
    ];

    const result = await fillAshbyForm(page, resolvedFields, '');
    assert.equal(result.filledCount, 1);
    assert.equal(result.filledFields[0].value, '+1 (555) 123-4567');

    const check = await verifyRequiredFieldsCommitted(page, ['phone_num']);
    assert.equal(check.allCommitted, true);
  });
});
