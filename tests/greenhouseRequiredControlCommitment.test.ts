import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { validateGreenhouseSubmission } from '../src/submitter/greenhouseValidation.js';
import { fillSingleField } from '../src/submitter/formFiller.js';

const html = `<!doctype html>
<form>
  <div class="select" id="country-root">
    <label for="country">Country</label>
    <input id="country" role="combobox" aria-expanded="false" autocomplete="off">
    <div class="select__menu" style="display:none"><div class="select__option" role="option">United States</div></div>
    <input class="requiredInput" type="text" required value="" style="display:none">
  </div>
  <div class="select" id="race-root">
    <label for="race">Please identify your race</label>
    <input id="race" role="combobox" aria-expanded="false" autocomplete="off">
    <input class="requiredInput" type="text" required value="" style="display:none">
  </div>
</form>
<script>
  const combo = document.querySelector('#country');
  const menu = document.querySelector('.select__menu');
  combo.addEventListener('focus', () => { menu.style.display = 'block'; combo.setAttribute('aria-expanded', 'true'); });
  combo.addEventListener('click', () => { menu.style.display = 'block'; combo.setAttribute('aria-expanded', 'true'); });
  combo.addEventListener('input', () => { menu.style.display = 'block'; combo.setAttribute('aria-expanded', 'true'); });
  // Deliberately clickable, but leaves the displayed and required values empty.
  document.querySelector('[role="option"]').addEventListener('click', () => { menu.style.display = 'none'; });
</script>`;

async function withMockPage(run: (url: string) => Promise<void>, content = html): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(content);
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

const application = { id: 'app', applywizz_id: 'AWL-TEST', resolved_fields: [] } as any;

const demographicCommitmentHtml = (dispatchesFrameworkEvent: boolean) => `<!doctype html>
<form>
  <div class="field-wrapper">
    <label>Race</label>
    <div id="race" class="select__control" role="combobox" aria-expanded="false">
      <div class="select__single-value"></div>
      <input class="select__input" type="text" aria-label="Race">
    </div>
    <div class="select__menu" style="display:none"><div class="select__option" role="option">Option One</div></div>
    <input class="requiredInput" type="text" required value="" style="display:none">
  </div>
</form>
<script>
  const control = document.querySelector('#race');
  const input = control.querySelector('input');
  const menu = document.querySelector('.select__menu');
  const selected = control.querySelector('.select__single-value');
  control.addEventListener('click', () => { menu.style.display = 'block'; });
  input.addEventListener('input', () => { menu.style.display = 'block'; });
  document.querySelector('[role="option"]').addEventListener('click', () => {
    selected.textContent = 'Option One';
    menu.style.display = 'none';
  });
  ${dispatchesFrameworkEvent ? `input.addEventListener('change', () => {
    document.querySelector('.requiredInput').value = selected.textContent;
  });` : ''}
</script>`;

const educationCountryCommitmentHtml = (dispatchesFrameworkEvent: boolean) => `<!doctype html>
<form>
  <div class="select-shell">
    <label>Country of education</label>
    <div id="education-country" class="select__control" role="combobox" aria-expanded="false">
      <div class="select__single-value"></div>
      <input class="select__input" type="text" aria-label="Country of education">
    </div>
    <div class="select__menu" style="display:none"><div class="select__option" role="option">Option One</div></div>
    <input type="hidden" name="education_country" required value="">
  </div>
</form>
<script>
  const control = document.querySelector('#education-country');
  const input = control.querySelector('input');
  const menu = document.querySelector('.select__menu');
  const selected = control.querySelector('.select__single-value');
  control.addEventListener('click', () => { menu.style.display = 'block'; });
  input.addEventListener('input', () => { menu.style.display = 'block'; });
  document.querySelector('[role="option"]').addEventListener('click', () => {
    selected.textContent = 'Option One';
    menu.style.display = 'none';
  });
  ${dispatchesFrameworkEvent ? `input.addEventListener('change', () => {
    document.querySelector('[name="education_country"]').value = selected.textContent;
  });` : ''}
</script>`;

for (const fixture of [
  { label: 'demographic select', selector: '#race', content: demographicCommitmentHtml },
  { label: 'education country combobox', selector: '#education-country', content: educationCountryCommitmentHtml },
]) {
  for (const dispatchesFrameworkEvent of [false, true]) {
    const content = fixture.content(dispatchesFrameworkEvent);
    await withMockPage(async (url) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(url);
        const result = await fillSingleField(page, {
          fieldId: fixture.selector.slice(1),
          name: fixture.selector.slice(1),
          type: 'select',
          label: fixture.label,
          value: 'Option One',
          options: ['Option One'],
          isRequired: true,
          metadata: { selector: fixture.selector },
        } as any, 'TEST', []);

        assert.equal(result.success, dispatchesFrameworkEvent, `${fixture.label}: only committed framework state succeeds`);
        assert.equal(result.domCommitted, dispatchesFrameworkEvent, `${fixture.label}: displayed-only selection is not committed`);
        const requiredValue = fixture.selector === '#race'
          ? page.locator('.requiredInput')
          : page.locator('[name="education_country"]');
        assert.equal(await requiredValue.inputValue(), dispatchesFrameworkEvent ? 'Option One' : '', `${fixture.label}: hidden required value reflects framework state`);
        if (!dispatchesFrameworkEvent) {
          const gate = await validateGreenhouseSubmission(page, application, {
            applicationId: 'app', jobUrl: url, totalFields: 1, filledFields: 0, failedFields: 1,
            results: [result],
          } as any);
          assert.equal(gate.ok, false, `${fixture.label}: required hidden/native value blocks submission`);
        }
        await page.close();
      } finally {
        await browser.close();
      }
    }, content);
  }
}

await withMockPage(async (url) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const result = await fillSingleField(page, {
      fieldId: 'country',
      name: 'country',
      type: 'select',
      label: 'Country',
      value: 'United States',
      isRequired: true,
      metadata: { selector: '#country' },
    } as any, 'TEST', []);

    assert.equal(result.success, false, 'A click without a selected value must not count as success');
    assert.equal(result.domCommitted, false, 'An uncommitted select must remain uncommitted');

    const gate = await validateGreenhouseSubmission(page, application, {
      applicationId: 'app', jobUrl: url, totalFields: 0, filledFields: 0, failedFields: 0,
      results: [],
    } as any);
    assert.equal(gate.ok, false);
    if (gate.ok) return;
    assert.deepEqual(gate.failure.fields.map((field) => field.label), ['Country', 'Please identify your race']);
    assert.equal(new Set(gate.failure.fields.map((field) => field.fieldId)).size, 2);
    assert(gate.failure.fields.every((field) => field.fieldId.length > 0));
    assert(gate.failure.fields.every((field) => field.message.length > 0));

    await page.setContent(`<form>
      <div class="field">
        <label><input type="checkbox" name="consent" checked> I agree</label>
        <label><input type="checkbox" name="consent" required> I do not agree</label>
      </div>
    </form>`);
    const satisfiedGroupGate = await validateGreenhouseSubmission(page, application, {
      applicationId: 'app', jobUrl: url, totalFields: 0, filledFields: 0, failedFields: 0, results: [],
    } as any);
    assert.equal(satisfiedGroupGate.ok, true, 'A checked checkbox satisfies its existing group semantics');
    assert.equal(await page.locator('input[name="consent"]:not(:checked)').getAttribute('required'), '');

    await page.setContent(`<form>
      <div class="field">
        <label><input type="checkbox" name="consent" checked> I agree</label>
        <label><input type="checkbox" name="consent" required> I do not agree</label>
      </div>
      <div class="field"><label><input type="checkbox" name="consent" required> Separate consent</label></div>
    </form>`);
    const unsatisfiedCheckboxGate = await validateGreenhouseSubmission(page, application, {
      applicationId: 'app', jobUrl: url, totalFields: 0, filledFields: 0, failedFields: 0, results: [],
    } as any);
    assert.equal(unsatisfiedCheckboxGate.ok, false, 'An unchecked required checkbox outside a satisfied field group must block');
    assert.equal(await page.locator('input[name="consent"][required]').last().getAttribute('required'), '');

    await page.setContent(`<form>
      <div class="select">
        <label>Country</label>
        <input id="shared-combobox" name="shared" role="combobox">
        <input type="text" required value="" style="display:none">
      </div>
      <div class="select">
        <label>Please identify your race</label>
        <input id="shared-combobox" name="shared" role="combobox">
        <input type="text" required value="" style="display:none">
      </div>
    </form>`);
    const duplicateIdentityGate = await validateGreenhouseSubmission(page, application, {
      applicationId: 'app', jobUrl: url, totalFields: 0, filledFields: 0, failedFields: 0, results: [],
    } as any);
    assert.equal(duplicateIdentityGate.ok, false);
    if (duplicateIdentityGate.ok) return;
    assert.deepEqual(duplicateIdentityGate.failure.fields.map((field) => field.label), ['Country', 'Please identify your race']);
    assert.equal(new Set(duplicateIdentityGate.failure.fields.map((field) => field.fieldId)).size, 2);
    assert(duplicateIdentityGate.failure.fields.every((field) => field.fieldId.length > 0));
    await page.close();
  } finally {
    await browser.close();
  }
});

console.log('Greenhouse required-control commitment tests passed');
