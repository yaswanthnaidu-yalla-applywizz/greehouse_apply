import http from 'http';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { fillForm } from '../src/submitter/formFiller.js';
import type { ResolvedField } from '../src/types/index.js';

const DEMOGRAPHIC_CASCADE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Demographic Test</title></head>
<body>
  <form id="application_form">
    <div class="field">
      <label for="first_name">First Name *</label>
      <input type="text" id="first_name" name="first_name" value="Test" required />
    </div>

    <!-- Prerequisite choice field: Hispanic/Latino -->
    <div class="field">
      <label for="hispanic_ethnicity">Are you Hispanic/Latino? *</label>
      <select id="hispanic_ethnicity" name="hispanic_ethnicity">
        <option value="">Select...</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    </div>

    <!-- Conditionally revealed choice field: Race (hidden until Hispanic is No) -->
    <div id="race_container" style="display: none;">
      <label for="race">Please identify your race *</label>
      <select id="race" name="race">
        <option value="">Select...</option>
        <option value="Asian">Asian</option>
        <option value="White">White</option>
        <option value="Black or African American">Black or African American</option>
      </select>
    </div>
  </form>

  <script>
    document.getElementById('hispanic_ethnicity').addEventListener('change', function() {
      if (this.value === 'No') {
        document.getElementById('race_container').style.display = 'block';
      } else {
        document.getElementById('race_container').style.display = 'none';
      }
    });
  </script>
</body>
</html>
`;

describe('Dynamic Select Cascade Retry', () => {
  let server: http.Server;
  let serverUrl: string;
  let browser: Browser;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DEMOGRAPHIC_CASCADE_HTML);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('re-attempts and fills dynamically mounted select field (Race) in retry sweep', async () => {
    const page = await browser.newPage();
    await page.goto(serverUrl);

    // Initial fields list ordered such that race is evaluated first or concurrently,
    // fails because #race is hidden, then hispanic_ethnicity is filled as "No"
    const fields: ResolvedField[] = [
      {
        fieldId: 'race',
        name: 'race',
        label: 'Please identify your race',
        type: 'select',
        value: 'Asian',
        source: 'supabase',
        options: ['Asian', 'White', 'Black or African American'],
      },
      {
        fieldId: 'hispanic_ethnicity',
        name: 'hispanic_ethnicity',
        label: 'Are you Hispanic/Latino?',
        type: 'select',
        value: 'No',
        source: 'supabase',
        options: ['Yes', 'No'],
      },
    ];

    const summary = await fillForm(page, {
      id: 'test-app',
      applywizz_id: 'test-candidate',
      resolved_fields: fields,
    } as any);

    const raceValue = await page.$eval('#race', (el: HTMLSelectElement) => el.value);
    assert.equal(raceValue, 'Asian', 'Race select field should have been filled upon retry after being revealed');

    await page.close();
  });
});
