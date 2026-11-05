import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { fillSingleField, getSelectValue } from '../src/submitter/formFiller.js';
import type { ResolvedField } from '../src/types/index.js';

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><form>
<label for="experience">Experience</label><select id="experience"><option value="">Choose</option><option value="0">0</option><option value="1">1</option><option value="No">No</option></select>
<label for="431">Race</label><select id="431"><option value="">Choose</option><option>Decline to self-identify</option></select>
<label for="question_69882431">LinkedIn</label><input id="question_69882431">
<label for="address_country">Country</label><select id="address_country"><option>Choose</option><option>USA</option></select>
<label for="country">Phone country code</label><select id="country"><option>Choose</option><option>United States +1</option></select>
<label for="relocation">Relocation</label><select id="relocation"><option value="">Choose</option><option>Yes — I am willing to relocate to the NYC area</option></select>
</form></body></html>`;

async function run(): Promise<void> {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const select = async (fieldId: string, name: string, label: string, value: string, options: string[]) => {
      await fillSingleField(page, { fieldId, name, type: 'select', label, value, options, isRequired: true, source: 'tier1', resolvedByTier: 1, confidence: 1 } as ResolvedField, 'test', []);
      return page.locator(`[id="${fieldId}"]`).inputValue();
    };
    assert.equal(await select('experience', 'experience', 'Experience', '0', ['0', '1', 'No']), '0');
    assert.equal(await select('experience', 'experience', 'Experience', '1', ['0', '1', 'No']), '1');
    assert.equal(await select('431', 'question_431', 'Race', 'Decline to self-identify', ['Decline to self-identify']), 'Decline to self-identify');
    assert.equal(await page.locator('#question_69882431').inputValue(), '');
    await select('address_country', 'address_country', 'Country', 'USA', ['USA', 'United States +1']);
    await select('country', 'country', 'Phone country code', 'United States +1', ['United States +1']);
    assert.deepEqual(await page.locator('#address_country').inputValue(), 'USA');
    assert.deepEqual(await page.locator('#country').inputValue(), 'United States +1');
    const relocation = { fieldId: 'relocation', name: 'relocation', type: 'select', label: 'Relocation', value: 'Yes — I am willing to relocate to the NYC area', options: ['Yes — I am willing to relocate to the NYC area'], isRequired: true, source: 'tier1', resolvedByTier: 1, confidence: 1 } as ResolvedField;
    assert.equal(getSelectValue(relocation, relocation.value), relocation.value);
    await fillSingleField(page, relocation, 'test', []);
    assert.equal(await page.locator('#relocation').inputValue(), 'Yes — I am willing to relocate to the NYC area');
    console.log('PASS: exact choice values, numeric field identity, country controls, and literal em-dash choice');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
