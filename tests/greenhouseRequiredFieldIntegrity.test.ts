import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import { fillSingleField, getSelectValue } from '../src/submitter/formFiller.js';
import { validateGreenhouseSubmission } from '../src/submitter/greenhouseValidation.js';
import type { ResolvedField, ScannedField } from '../src/types/index.js';

const headless = process.env.TEST_HEADLESS !== 'false';
const resolver = new AnswerResolver();
const profile = {
  country: 'Canada',
  country_code: '+1',
  raw_api_payload: { additional_information: { zip_or_country: 'Canada' } },
} as any;

const required = (overrides: Partial<ScannedField>): ScannedField => ({
  fieldId: '', name: '', type: 'select', label: '', isRequired: true,
  ...overrides,
});

const html = `<!doctype html><form id="application_form">
  <label for="authorization">I agree to the terms and conditions</label>
  <select id="authorization"><option value="">Choose</option><option value="0">0</option><option value="Yes — I agree">Yes — I agree</option></select>
  <label for="431">I agree to the application policy</label>
  <select id="431" name="question_431"><option value="">Choose</option><option value="I agree">I agree</option></select>
  <label for="years">Years of experience</label>
  <select id="years"><option value="">Choose</option><option value="0">0</option><option value="1">1</option></select>
  <label for="address_country">Country</label>
  <select id="address_country"><option value="">Choose</option><option>Canada</option><option>United States</option></select>
  <label for="country">Phone Country</label>
  <select id="country"><option value="">Choose</option><option>Canada +1</option><option>United States +1</option></select>
  <label for="date_month">Start date month</label>
  <input id="date_month">
  <div class="select" id="custom-choice-root">
    <label for="custom_choice">Authorization</label>
    <input id="custom_choice" role="combobox" aria-expanded="false" autocomplete="off">
    <div class="select__menu" style="display:none"><div class="select__option" role="option">Yes — I agree</div></div>
    <input class="requiredInput" type="text" value="" style="display:none">
  </div>
</form>
<script>
  const combo = document.querySelector('#custom_choice');
  const menu = document.querySelector('.select__menu');
  combo.addEventListener('focus', () => { menu.style.display = 'block'; combo.setAttribute('aria-expanded', 'true'); });
  combo.addEventListener('click', () => { menu.style.display = 'block'; combo.setAttribute('aria-expanded', 'true'); });
  combo.addEventListener('input', () => { menu.style.display = 'block'; combo.setAttribute('aria-expanded', 'true'); });
  document.querySelector('#custom-choice-root [role="option"]').addEventListener('click', () => { menu.style.display = 'none'; });
</script>`;

const embeddedHtml = `<!doctype html><form id="application_form">
  <label for="embedded_policy">I agree to the application policy</label>
  <select id="embedded_policy"><option value="">Choose</option><option>I agree</option></select>
</form>`;

async function withFixture(run: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(request.url === '/application' ? embeddedHtml : `${html}<iframe id="application-frame" src="/application"></iframe>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function resolveAndFill(page: any, scanned: ScannedField, control?: ResolvedField) {
  const resolved = control || await resolver.resolveField('SYNTHETIC-LOCAL-FIXTURE', scanned, {
    profile,
    parsedResume: null,
    qaEntries: [],
    jobContext: { companyName: 'Local Fixture', jobTitle: 'Verification' },
  });
  const fill = await fillSingleField(page, resolved, 'SYNTHETIC-LOCAL-FIXTURE', [], { minJitterMs: 0, maxJitterMs: 0 });
  const gate = await validateGreenhouseSubmission(page, { id: 'local-fixture', applywizz_id: 'SYNTHETIC-LOCAL-FIXTURE', resolved_fields: [] } as any, {
    applicationId: 'local-fixture', jobUrl: page.url(), totalFields: 1,
    filledFields: Number(fill.success), failedFields: Number(!fill.success), results: [fill],
  });
  return { resolved, fill, gate };
}

await withFixture(async (url) => {
  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage();
    await page.goto(url);

    const agreement = await resolveAndFill(page, required({
      fieldId: 'authorization', name: 'authorization', type: 'select',
      label: 'I agree to the terms and conditions', options: ['0', 'Yes — I agree'],
      metadata: { selector: '#authorization' },
    }));
    assert.equal(agreement.resolved.value, 'Yes — I agree');
    assert.equal(agreement.gate.ok, true, 'a valid required field passes the submission gate');

    const numeric = { fieldId: 'years', name: 'years', type: 'select', label: 'Years of experience', value: '0', options: ['0', '1'], isRequired: true, metadata: { selector: '#years' } } as ResolvedField;
    assert.equal(getSelectValue(numeric, '0'), '0', 'literal numeric choice is preserved');
    const numericFill = await fillSingleField(page, numeric, 'SYNTHETIC-LOCAL-FIXTURE', [], { minJitterMs: 0, maxJitterMs: 0 });
    assert.equal(numericFill.success, true);
    assert.equal(await page.locator('#years').inputValue(), '0');

    const numericId = await resolveAndFill(page, required({
      fieldId: '431', name: 'question_431', type: 'select', label: 'I agree to the application policy',
      options: ['I agree'], metadata: { selector: '[id="431"]' },
    }));
    assert.equal(numericId.resolved.value, 'I agree');
    assert.equal(await page.locator('[id="431"]').inputValue(), 'I agree');

    const address = await resolveAndFill(page, required({
      fieldId: 'address_country', name: 'address_country', type: 'select', label: 'Country',
      options: ['Canada', 'United States'], metadata: { selector: '#address_country' },
    }));
    assert.equal(address.resolved.value, 'Canada');
    assert.equal(await page.locator('#address_country').inputValue(), 'Canada');
    const phoneCountry = await fillSingleField(page, {
      fieldId: 'country', name: 'country', type: 'select', label: 'Phone Country', value: 'Canada +1',
      options: ['Canada +1', 'United States +1'], isRequired: true, metadata: { selector: '#country' },
    } as ResolvedField, 'SYNTHETIC-LOCAL-FIXTURE', [], { minJitterMs: 0, maxJitterMs: 0 });
    assert.equal(phoneCountry.success, true);
    assert.equal(await page.locator('#country').inputValue(), 'Canada +1');

    const date = await resolver.resolveField('SYNTHETIC-LOCAL-FIXTURE', required({
      fieldId: 'date_month', name: 'start_date_month', type: 'select', label: 'Start date month',
      options: [], optionsComplete: false, metadata: { selector: '#date_month' },
    }), {
      profile: { ...profile, raw_api_payload: { additional_information: { start_date: '2026-10-05' } } } as any,
      parsedResume: null, qaEntries: [], jobContext: { companyName: 'Local Fixture', jobTitle: 'Verification' },
    });
    assert.equal(date.source, 'unresolved');
    assert.equal(date.value, '');

    const uncommitted = await fillSingleField(page, {
      fieldId: 'custom_choice', name: 'custom_choice', type: 'select', label: 'Authorization', value: 'Yes — I agree',
      isRequired: true, metadata: { selector: '#custom_choice' },
    } as ResolvedField, 'SYNTHETIC-LOCAL-FIXTURE', [], { minJitterMs: 0, maxJitterMs: 0 });
    const blocked = await validateGreenhouseSubmission(page, { id: 'local-fixture', applywizz_id: 'SYNTHETIC-LOCAL-FIXTURE', resolved_fields: [] } as any, {
      applicationId: 'local-fixture', jobUrl: url, totalFields: 1, filledFields: Number(uncommitted.success),
      failedFields: Number(!uncommitted.success), results: [uncommitted],
    });
    assert.equal(uncommitted.success, false);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.match(blocked.failure.fields[0].message, /Required field was not committed/);

    const frame = page.frames().find((candidate) => candidate.url().endsWith('/application'));
    assert(frame, 'embedded application iframe loaded');
    const embedded = await resolveAndFill(frame as any, required({
      fieldId: 'embedded_policy', name: 'embedded_policy', type: 'select', label: 'I agree to the application policy',
      options: ['I agree'], metadata: { selector: '#embedded_policy' },
    }));
    assert.equal(embedded.gate.ok, true, 'the same resolver, filler, and gate operate in the embedded application frame');
    await page.close();
  } finally {
    await browser.close();
  }
});

console.log(`Greenhouse required-field integrity fixture passed (${headless ? 'headless' : 'headful'})`);
