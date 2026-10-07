import http from 'http';
import { chromium, type Browser } from 'playwright';
import { enrichMissingChoiceOptions } from '../src/scanner/liveChoiceOptions.js';
import { PlaywrightScanner } from '../src/scanner/playwrightScanner.js';
import type { ScannedField } from '../src/types/index.js';

const MOCK_GREENHOUSE_FORM = `
<!DOCTYPE html>
<html><head><style>
  .select__container { width: 300px; min-height: 40px; }
  .select__menu { display: none; }
  .select__menu.open { display: block; }
</style></head><body>
  <form id="application_form">
    <div class="select__container">
      <label id="1333-label" for="1333">Race</label>
      <div class="select-shell remix-css-test">
        <button type="button" class="select__control" id="race-trigger" aria-haspopup="listbox">Select...</button>
      </div>
      <select id="1333" name="1333" style="display:none" aria-hidden="true">
        <option value="">Select...</option>
      </select>
    </div>
    <div class="field">
      <label for="country">Country</label>
      <select id="country" name="country">
        <option value="">Select...</option>
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>
    </div>
    <div class="select__container">
      <label for="school">School</label>
      <button type="button" id="school" class="select__control" aria-haspopup="listbox">Search schools</button>
    </div>
    <div id="conditional-demographics" style="display:none">
      <div class="select__container">
        <label id="1336-label" for="1336">Protected Veteran Status</label>
        <div class="select-shell">
          <button type="button" class="select__control" id="veteran-trigger" aria-haspopup="listbox">Select...</button>
        </div>
        <select id="1336" name="1336" style="display:none" aria-hidden="true"><option value="">Select...</option></select>
      </div>
    </div>
  </form>
  <div id="menu-portal">
    <div class="select__menu" id="race-menu" role="listbox" style="max-height:32px;overflow-y:auto">
      <div class="select__option" role="option">Asian</div>
      <div class="select__option" role="option">White</div>
      <div class="select__option" role="option">Decline to self-identify</div>
    </div>
    <div class="select__menu" id="veteran-menu" role="listbox">
      <div class="select__option" role="option">I am a protected veteran</div>
      <div class="select__option" role="option">I am not a protected veteran</div>
    </div>
  </div>
  <script>
    document.getElementById('race-trigger').addEventListener('mousedown', function() {
      document.getElementById('race-menu').classList.add('open');
    });
    document.getElementById('race-trigger').addEventListener('keydown', function(event) {
      if (event.key === 'Escape') document.getElementById('race-menu').classList.remove('open');
    });
    document.getElementById('veteran-trigger').addEventListener('mousedown', function() {
      document.getElementById('veteran-menu').classList.add('open');
    });
    document.getElementById('veteran-trigger').addEventListener('keydown', function(event) {
      if (event.key === 'Escape') document.getElementById('veteran-menu').classList.remove('open');
    });
    document.getElementById('school').addEventListener('mousedown', function() {
      window.schoolMenuOpened = true;
    });
  </script>
</body></html>
`;

const MOCK_REMIX_CONDITIONAL_FORM = `
<!DOCTYPE html>
<html><body>
  <form id="application_form">
    <label for="start_date">Date Available to Start?</label>
    <input id="start_date" name="start_date" type="date" />
    <label for="availability_text">Earliest Start Date</label>
    <input id="availability_text" name="availability_text" type="text" placeholder="DD/MM/YYYY" />
    <label for="authorization">Authorized to work?</label>
    <select id="authorization" name="authorization">
      <option value="">Select...</option><option value="Yes">Yes</option><option value="No">No</option>
    </select>
    <div id="conditional-race" style="display:none">
      <div class="select__container">
        <label id="1333-label" for="1333">Race</label>
        <div class="select-shell">
          <button type="button" class="select__control" id="race-trigger" aria-haspopup="listbox">Select...</button>
          <div class="select__menu" id="race-menu" role="listbox" style="display:none">
            <div class="select__option" role="option">Asian</div>
            <div class="select__option" role="option">White</div>
          </div>
        </div>
        <select id="1333" name="1333" style="display:none"><option value="">Select...</option></select>
      </div>
    </div>
    <button type="submit">Submit Application</button>
  </form>
  <script>
    window.__remixContext = { state: { loaderData: { root: { jobPost: {
      title: 'Test Job',
      company_name: 'Test Company',
      questions: [
        { label: 'Date Available to Start?', required: true, fields: [{ name: 'start_date', type: 'input' }] },
        { label: 'Earliest Start Date', required: true, fields: [{ name: 'availability_text', type: 'input' }] },
        { label: 'Authorized to work?', required: true, fields: [
          { name: 'authorization', type: 'single_select', values: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }] }
        ] }
      ],
      eeoc_sections: [{ title: 'Voluntary Self-Identification', questions: [
        { label: 'Race', required: true, fields: [{ name: '1333', type: 'single_select' }] }
      ] }]
    } } } } };
    document.getElementById('authorization').addEventListener('change', function(event) {
      document.getElementById('conditional-race').style.display = event.target.value === 'Yes' ? 'block' : 'none';
    });
    document.getElementById('race-trigger').addEventListener('mousedown', function() {
      document.getElementById('race-menu').style.display = 'block';
    });
  </script>
</body></html>
`;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url === '/remix' ? MOCK_REMIX_CONDITIONAL_FORM : MOCK_GREENHOUSE_FORM);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start mock form server.');

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);

    const fields: ScannedField[] = [
      {
        fieldId: 'race',
        name: '1333',
        type: 'select',
        label: 'Race',
        isRequired: true,
        metadata: { selector: '#1333' },
      },
      {
        fieldId: 'country',
        name: 'country',
        type: 'select',
        label: 'Country',
        isRequired: true,
        metadata: { selector: '#country' },
      },
      {
        fieldId: 'known',
        name: 'question_known',
        type: 'select',
        label: 'Known choices',
        isRequired: false,
        options: ['Already captured'],
      },
      {
        fieldId: 'school',
        name: 'school',
        type: 'select',
        label: 'School',
        isRequired: false,
        metadata: { selector: '#school' },
      },
      {
        fieldId: 'veteran_status',
        name: '1336',
        type: 'select',
        label: 'Protected Veteran Status',
        isRequired: true,
        metadata: { selector: '#1336' },
      },
    ];

    const captureReasons: string[] = [];
    const enriched = await enrichMissingChoiceOptions(page, fields, (field, reason) => captureReasons.push(`${field.label}: ${reason}`));
    assert(enriched[0].options?.join('|') === 'Asian|White|Decline to self-identify', 'extracts visible custom Greenhouse choices for fields missing Remix values');
    assert(enriched[0].optionsComplete === false, `marks scrollable custom menus as partial (got ${JSON.stringify(enriched)}; ${captureReasons.join('; ')})`);
    assert(enriched[1].options?.join('|') === 'United States|Canada', 'extracts native select choices and omits placeholder');
    assert(enriched[1].optionsComplete === true, 'marks native select option lists complete');
    assert(enriched[2].options?.[0] === 'Already captured', 'preserves options already provided by Remix');
    assert(!enriched[3].options, 'does not enumerate optional dropdown options');
    assert(!(await page.evaluate('window.schoolMenuOpened === true')), 'does not open optional dropdowns');
    assert(!enriched[4].options, 'does not try to open a hidden conditional select');
    assert((await page.locator('select[id="1333"]').inputValue()) === '', 'enrichment does not select or modify any answer');
    await page.locator('#conditional-demographics').evaluate((element) => { (element as HTMLElement).style.display = 'block'; });
    const revealed = await enrichMissingChoiceOptions(page, [{ ...enriched[4], isRequired: true }]);
    assert(revealed[0].options?.length === 2, 'captures options after a conditional dropdown becomes visible');
    assert(revealed[0].optionsComplete === true, 'marks a finite custom menu complete');
    await page.close();

    const scanner = new PlaywrightScanner({ headless: true, minJitterMs: 0, maxJitterMs: 0 });
    const scanPage = await browser.newPage();
    const scannedTemplate = await scanner.scanSingleUrl(`http://127.0.0.1:${address.port}/remix`, scanPage);
    const scannedStartDate = scannedTemplate.fields.find((field) => field.name === 'start_date');
    assert(scannedStartDate?.type === 'date', 'Remix scan identifies date controls from the live form DOM');
    assert(
      scannedStartDate?.metadata?.expectedDateFormat === 'YYYY-MM-DD',
      'Remix scan captures the native ISO date format'
    );
    const scannedTextDate = scannedTemplate.fields.find((field) => field.name === 'availability_text');
    assert(
      scannedTextDate?.metadata?.expectedDateFormat === 'DD/MM/YYYY',
      'Remix scan captures textual placeholder date formatting'
    );
    const scannedRace = scannedTemplate.fields.find((field) => field.label === 'Race');
    assert(scannedRace?.options?.join('|') === 'Asian|White', 'Remix scan captures missing options after cascade exploration reveals the EEOC field');
    assert(scannedRace?.optionsComplete === true, 'marks authoritative Remix choice values complete');
    await scanPage.close();
  } finally {
    if (browser) await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log('Live choice option enrichment tests passed.');
}

void run();
