/**
 * @fileoverview Tests searchable/combobox select filling (sponsorship Y/N type-ahead).
 */

import http from 'http';
import { chromium, type Browser } from 'playwright';
import { fillSingleField } from '../src/submitter/formFiller.js';
import type { ResolvedField } from '../src/types/index.js';

const MOCK_TYPEAHEAD_SPONSORSHIP_HTML = `
<!DOCTYPE html>
<html><body>
<form id="application_form">
  <label for="sponsorship_combobox">Will you require sponsorship to work in the United States? *</label>
  <div class="select-shell" id="sponsorship_shell">
    <div class="select__control" tabindex="0">
      <input class="select__input" id="sponsorship_combobox" role="combobox" aria-expanded="false" autocomplete="off" />
      <div class="select__single-value"></div>
    </div>
    <div class="select__menu" id="sponsorship_menu" style="display:none;">
      <div class="select__option" role="option">Yes</div>
      <div class="select__option" role="option">No</div>
    </div>
  </div>
  <input type="hidden" id="sponsorship_value" name="require_sponsorship" value="" />
</form>
<script>
  var input = document.getElementById('sponsorship_combobox');
  var menu = document.getElementById('sponsorship_menu');
  var hidden = document.getElementById('sponsorship_value');
  var options = menu.querySelectorAll('.select__option');

  function showMenu() {
    menu.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    options.forEach(function(o) { o.style.display = ''; });
  }
  function hideMenu() {
    menu.style.display = 'none';
    input.setAttribute('aria-expanded', 'false');
  }

  input.addEventListener('focus', showMenu);
  input.addEventListener('click', showMenu);
  document.querySelector('.select__control').addEventListener('click', function() {
    input.focus();
    showMenu();
  });

  input.addEventListener('input', function() {
    showMenu();
    var q = input.value.trim().toLowerCase();
    options.forEach(function(o) {
      var t = o.textContent.trim().toLowerCase();
      o.style.display = !q || t.indexOf(q) === 0 ? '' : 'none';
    });
  });

  options.forEach(function(o) {
    o.addEventListener('click', function() {
      hidden.value = o.textContent.trim();
      document.querySelector('.select__single-value').textContent = o.textContent.trim();
      input.value = o.textContent.trim();
      hideMenu();
    });
  });
</script>
</body></html>
`;

/** Greenhouse job-board remix-css: select_input-container + combobox input (no native select). */
const MOCK_GREENHOUSE_REMIX_SPONSORSHIP_HTML = `
<!DOCTYPE html>
<html><body>
<form id="application_form">
  <label for="question_32545417010003">Will you now or in the future require sponsorship to work in the U.S.? *</label>
  <div class="select-shell remix-css-abc">
    <div class="select_input-container">
      <input class="remix-css-input" id="question_32545417010003" role="combobox" aria-expanded="false" autocomplete="off" type="text" />
    </div>
    <input type="hidden" class="requiredInput" id="requiredInput_32545417010003" value="" required />
    <div class="select__menu" id="menu_32545417010003" style="display:none;">
      <div class="select__option" role="option">Yes</div>
      <div class="select__option" role="option">No</div>
    </div>
  </div>
  <select id="question_32545417010003_native" name="question_32545417010003" style="display:none" aria-hidden="true">
    <option value=""></option>
  </select>
</form>
<script>
  var input = document.getElementById('question_32545417010003');
  var menu = document.getElementById('menu_32545417010003');
  var hidden = document.getElementById('question_32545417010003_native');
  var requiredInput = document.getElementById('requiredInput_32545417010003');
  var options = menu.querySelectorAll('.select__option');
  function showMenu() {
    menu.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    options.forEach(function(o) { o.style.display = ''; });
  }
  input.addEventListener('focus', showMenu);
  input.addEventListener('click', showMenu);
  input.addEventListener('input', function() {
    showMenu();
    var q = input.value.trim().toLowerCase();
    options.forEach(function(o) {
      var t = o.textContent.trim().toLowerCase();
      o.style.display = !q || t.indexOf(q) === 0 ? '' : 'none';
    });
  });
  options.forEach(function(o) {
    o.addEventListener('click', function() {
      hidden.value = o.textContent.trim();
      menu.style.display = 'none';
      setTimeout(function() {
        input.value = o.textContent.trim();
        requiredInput.value = o.textContent.trim();
      }, 50);
    });
  });
</script>
</body></html>
`;

const MOCK_BUTTON_ONLY_SPONSORSHIP_HTML = `
<!DOCTYPE html>
<html><body>
<form id="application_form">
  <label for="sponsorship_trigger">Requires sponsorship (no type-ahead)? *</label>
  <div class="select-shell">
    <button type="button" class="select__control" id="sponsorship_trigger" aria-haspopup="listbox">Select...</button>
    <div class="select__menu" id="sponsorship_menu_btn" style="display:none;">
      <div class="select__option" role="option">Yes</div>
      <div class="select__option" role="option">No</div>
    </div>
  </div>
  <input type="hidden" id="sponsorship_value_btn" value="" />
</form>
<script>
  var btn = document.getElementById('sponsorship_trigger');
  var menu = document.getElementById('sponsorship_menu_btn');
  var hidden = document.getElementById('sponsorship_value_btn');
  btn.addEventListener('click', function() {
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });
  menu.querySelectorAll('.select__option').forEach(function(o) {
    o.addEventListener('click', function() {
      hidden.value = o.textContent.trim();
      btn.textContent = o.textContent.trim();
      menu.style.display = 'none';
    });
  });
</script>
</body></html>
`;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function withMockPage(html: string, fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Could not bind mock server');
  const url = `http://127.0.0.1:${addr.port}/`;
  try {
    await fn(url);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function runSearchableSelectTests(): Promise<void> {
  console.log('🧪 Searchable select (sponsorship combobox) tests...\n');
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });

    await withMockPage(MOCK_TYPEAHEAD_SPONSORSHIP_HTML, async (url) => {
      const page = await browser!.newPage();
      await page.goto(url);

      const field: ResolvedField = {
        fieldId: 'require_sponsorship',
        name: 'require_sponsorship',
        type: 'select',
        label: 'Will you require sponsorship to work in the United States?',
        value: 'Yes',
        required: true,
        metadata: { selector: '#sponsorship_combobox' },
      };

      const res = await fillSingleField(page, field, 'TEST', []);
      assert(res.success, 'Type-ahead sponsorship select should succeed');
      const hidden = await page.inputValue('#sponsorship_value');
      assert(hidden === 'Yes', `Expected hidden value Yes, got "${hidden}"`);

      const fieldNo: ResolvedField = { ...field, value: 'No' };
      await page.goto(url);
      const resNo = await fillSingleField(page, fieldNo, 'TEST', []);
      assert(resNo.success, 'Type-ahead sponsorship No should succeed');
      assert((await page.inputValue('#sponsorship_value')) === 'No', 'Expected No selected');

      await page.close();
      console.log('  ✅ Type-ahead combobox (Yes/No)');
    });

    await withMockPage(MOCK_GREENHOUSE_REMIX_SPONSORSHIP_HTML, async (url) => {
      const page = await browser!.newPage();
      await page.goto(url);

      const field: ResolvedField = {
        fieldId: 'will_you_now_or_in_the_future_require_sponsorship_to_work_in_the',
        name: 'question_32545417010003',
        type: 'select',
        label: 'Will you now or in the future require sponsorship to work in the U.S.?',
        value: 'Yes',
        required: true,
        metadata: { selector: '#question_32545417010003' },
      };

      const res = await fillSingleField(page, field, 'AWL-31428', []);
      assert(res.success, 'Greenhouse remix sponsorship select should succeed');
      assert((await page.inputValue('#question_32545417010003')) === 'Yes', 'Combobox input should show Yes');
      assert((await page.inputValue('#requiredInput_32545417010003')) === 'Yes', 'Hidden required input should show Yes');

      await page.close();
      console.log('  ✅ Greenhouse remix-css select_input-container (AWL-31428 sponsorship id)');
    });

    await withMockPage(MOCK_BUTTON_ONLY_SPONSORSHIP_HTML, async (url) => {
      const page = await browser!.newPage();
      await page.goto(url);

      const field: ResolvedField = {
        fieldId: 'require_sponsorship',
        name: 'require_sponsorship',
        type: 'select',
        label: 'Requires sponsorship (no type-ahead)?',
        value: 'No',
        required: true,
        metadata: { selector: '#sponsorship_trigger' },
      };

      const res = await fillSingleField(page, field, 'TEST', []);
      assert(res.success, 'Button-only combobox should succeed');
      assert((await page.inputValue('#sponsorship_value_btn')) === 'No', 'Expected No via button dropdown');

      await page.close();
      console.log('  ✅ Button-only dropdown (No)');
    });

    console.log('\n✅ All searchable select tests passed.');
  } finally {
    await browser?.close();
  }
}

runSearchableSelectTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
