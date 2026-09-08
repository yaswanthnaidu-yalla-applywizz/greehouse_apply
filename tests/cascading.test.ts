/**
 * @fileoverview Unit & Integration Tests for Phase V2-4b: Cascading Field Detection.
 */

import http from 'http';
import { createHash } from 'crypto';
import { chromium, type Browser } from 'playwright';
import { PlaywrightScanner } from '../src/scanner/playwrightScanner.js';
import { fillForm } from '../src/submitter/formFiller.js';
import { extractVisibleFormFields, getUnmappedVisibleFields } from '../src/submitter/cascadeDetector.js';
import { upsertProfile } from '../src/db/profiles.js';
import { upsertAnswer } from '../src/db/qaBank.js';
import type { ResolvedField } from '../src/types/index.js';

const MOCK_DYNAMIC_FORM_HTML = `
<!DOCTYPE html>
<html>
<head><title>Job Application for Senior Engineer at Acme Tech</title></head>
<body>
  <form id="application_form">
    <div class="field">
      <label for="first_name">First Name *</label>
      <input type="text" id="first_name" name="first_name" required />
    </div>

    <div class="field">
      <label for="last_name">Last Name *</label>
      <input type="text" id="last_name" name="last_name" required />
    </div>

    <div class="field">
      <label for="email">Email *</label>
      <input type="email" id="email" name="email" required />
    </div>

    <!-- Base Dropdown that triggers conditional field -->
    <div class="field">
      <label for="authorized_us">Are you legally authorized to work in the United States? *</label>
      <select id="authorized_us" name="authorized_us">
        <option value="">Select...</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    </div>

    <!-- Container for conditional field 1 -->
    <div id="sponsorship_container" style="display: none;">
      <label for="require_sponsorship">Will you now or in the future require visa sponsorship? *</label>
      <select id="require_sponsorship" name="require_sponsorship">
        <option value="">Select...</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    </div>

    <!-- Base Radio that triggers conditional field 2 -->
    <fieldset id="veteran_fieldset">
      <legend>Are you a protected veteran? *</legend>
      <label><input type="radio" name="is_veteran" value="Yes" /> Yes</label>
      <label><input type="radio" name="is_veteran" value="No" /> No</label>
    </fieldset>

    <!-- Container for conditional field 2 -->
    <div id="military_branch_container" style="display: none;">
      <label for="military_branch">Please specify your military branch *</label>
      <input type="text" id="military_branch" name="military_branch" />
    </div>

    <button type="submit" id="submit_app">Submit Application</button>
  </form>

  <script>
    // Dynamic conditional rendering event listeners
    document.getElementById('authorized_us').addEventListener('change', function(e) {
      var container = document.getElementById('sponsorship_container');
      if (e.target.value === 'No') {
        container.style.display = 'block';
      } else {
        container.style.display = 'none';
      }
    });

    document.querySelectorAll('input[name="is_veteran"]').forEach(function(radio) {
      radio.addEventListener('change', function(e) {
        var container = document.getElementById('military_branch_container');
        if (e.target.value === 'Yes') {
          container.style.display = 'block';
        } else {
          container.style.display = 'none';
        }
      });
    });
  </script>
</body>
</html>
`;

async function runCascadingTestSuite() {
  console.log('🧪 Starting Phase V2-4b Cascading Field Detection Tests...\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, testName: string) {
    total++;
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName}`);
    }
  }

  // 1. Setup local Mock HTTP Server
  const mockHttpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(MOCK_DYNAMIC_FORM_HTML);
  });

  await new Promise<void>((resolve) => mockHttpServer.listen(0, resolve));
  const mockPort = (mockHttpServer.address() as any).port;
  const mockFormUrl = `http://localhost:${mockPort}/dynamic-job`;

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // =========================================================================
    // Test Group 1: Cascade Detector Helper
    // =========================================================================
    console.log('\n--- Test Group 1: Cascade Detector DOM Extraction ---');
    const page = await browser.newPage();
    await page.goto(mockFormUrl);

    const initialVisible = await extractVisibleFormFields(page);
    assert(initialVisible.length >= 4, 'Initial visible fields extracted from DOM');

    const hasSponsorshipInitially = initialVisible.some((f) => f.name === 'require_sponsorship' || f.fieldId.includes('sponsorship'));
    assert(hasSponsorshipInitially === false, 'Hidden conditional field 1 not in initial visible list');

    // Trigger dropdown change
    await page.selectOption('#authorized_us', 'No');
    await page.waitForTimeout(600);

    const afterVisible = await extractVisibleFormFields(page);
    const hasSponsorshipAfter = afterVisible.some((f) => f.name === 'require_sponsorship' || f.fieldId.includes('sponsorship'));
    assert(hasSponsorshipAfter === true, 'Conditionally rendered field 1 visible after selecting "No"');

    const knownIds = new Set(initialVisible.map((f) => f.fieldId));
    const knownNames = new Set(initialVisible.map((f) => f.name));
    const unmapped = await getUnmappedVisibleFields(page, knownIds, knownNames);

    assert(unmapped.some((f) => f.name === 'require_sponsorship' || f.fieldId.includes('sponsorship')), 'getUnmappedVisibleFields returned newly visible field');

    await page.close();

    // =========================================================================
    // Test Group 2: Scanner Cascading Exploration
    // =========================================================================
    console.log('\n--- Test Group 2: Scanner Cascading Field Exploration ---');
    const scanner = new PlaywrightScanner({ headless: true, minJitterMs: 0, maxJitterMs: 0 });
    const scannedTemplate = await scanner.scanSingleUrl(mockFormUrl, await browser.newPage());

    assert(scannedTemplate.fields.length >= 6, `Scanner extracted all base + cascading fields (got ${scannedTemplate.fields.length})`);

    const sponsorshipField = scannedTemplate.fields.find((f) => f.name === 'require_sponsorship' || f.fieldId.includes('sponsorship'));
    assert(Boolean(sponsorshipField), 'Scanner captured cascading field "require_sponsorship"');
    assert(Boolean(sponsorshipField?.metadata?.dependsOn), 'sponsorshipField has dependsOn metadata');
    assert(sponsorshipField?.metadata?.triggerValue === 'No', 'sponsorshipField has triggerValue: "No"');

    const militaryField = scannedTemplate.fields.find((f) => f.name === 'military_branch' || f.fieldId.includes('military'));
    assert(Boolean(militaryField), 'Scanner captured cascading field "military_branch"');
    assert(Boolean(militaryField?.metadata?.dependsOn), 'militaryField has dependsOn metadata');
    assert(militaryField?.metadata?.triggerValue === 'Yes', 'militaryField has triggerValue: "Yes"');

    // =========================================================================
    // Test Group 3: Form Filler Dynamic Cascade Loop
    // =========================================================================
    console.log('\n--- Test Group 3: Form Filler Dynamic Cascade Loop ---');

    // Seed candidate profile & qa bank in DB for on-the-fly resolution
    const testApplywizzId = 'CASCADE-TEST-1';
    await upsertProfile({
      applywizz_id: testApplywizzId,
      client_name: 'Cascade Candidate',
      first_name: 'Cascade',
      last_name: 'Candidate',
      email: 'cascade@example.com',
      work_authorization: 'No',
      requires_sponsorship: true,
    });

    const fpSponsor = createHash('sha256').update('will you now or in the future require visa sponsorship?|select').digest('hex').slice(0, 16);
    const fpMilitary = createHash('sha256').update('please specify your military branch|text').digest('hex').slice(0, 16);

    await upsertAnswer({
      applywizz_id: testApplywizzId,
      question_fingerprint: fpSponsor,
      question_label: 'Will you now or in the future require visa sponsorship?',
      field_type: 'select',
      value: 'Yes',
      source: 'manual',
    });

    await upsertAnswer({
      applywizz_id: testApplywizzId,
      question_fingerprint: fpMilitary,
      question_label: 'Please specify your military branch',
      field_type: 'text',
      value: 'Navy',
      source: 'manual',
    });

    const fillPage = await browser.newPage();
    await fillPage.goto(mockFormUrl);

    // Initial resolved fields array ONLY contains base fields (no require_sponsorship or military_branch)
    const baseResolvedFields: ResolvedField[] = [
      { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Cascade', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'last_name', name: 'last_name', type: 'text', label: 'Last Name', value: 'Candidate', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'cascade@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'authorized_us', name: 'authorized_us', type: 'select', label: 'Are you authorized to work?', value: 'No', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'is_veteran', name: 'is_veteran', type: 'radio', label: 'Are you a veteran?', value: 'Yes', source: 'supabase', resolvedByTier: 1, confidence: 1 },
    ];

    const testAppRecord = {
      id: 'cascade-test-app',
      applywizz_id: testApplywizzId,
      job_url: mockFormUrl,
      status: 'READY_FOR_REVIEW' as const,
      resolved_fields: [...baseResolvedFields],
    };

    const fillSummary = await fillForm(fillPage, testAppRecord, {
      minJitterMs: 50,
      maxJitterMs: 100,
    });

    assert(fillSummary.totalFields >= 7, `Form filler resolved and populated dynamic fields (total: ${fillSummary.totalFields})`);
    assert(fillSummary.filledFields >= 7, `All initial and dynamic fields populated successfully (${fillSummary.filledFields}/${fillSummary.totalFields})`);
    assert(fillSummary.failedFields === 0, 'Form filler reported 0 failures');

    // Verify DOM values in page for cascading fields
    const sponsorshipVal = await fillPage.inputValue('#require_sponsorship');
    const militaryVal = await fillPage.inputValue('#military_branch');

    assert(sponsorshipVal === 'Yes', 'DOM select #require_sponsorship was populated via cascade loop ("Yes")');
    assert(militaryVal === 'Navy', 'DOM input #military_branch was populated via cascade loop ("Navy")');

    await fillPage.close();

    console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);

    if (passed === total) {
      console.log('🎉 All Phase V2-4b Cascading Field Detection tests passed successfully!');
    } else {
      console.error('❌ Some tests failed.');
      process.exit(1);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise<void>((resolve) => mockHttpServer.close(() => resolve()));
  }
}

runCascadingTestSuite().catch((err) => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
