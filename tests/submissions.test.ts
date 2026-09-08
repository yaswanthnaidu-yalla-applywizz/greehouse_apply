/**
 * @fileoverview Unit and Integration Tests for Phase V2-4: Playwright Form Filler & Submission Engine.
 */

import http from 'http';
import { chromium, type Browser } from 'playwright';
import { fillForm } from '../src/submitter/formFiller.js';
import { detectCaptcha } from '../src/submitter/liveSubmit.js';
import {
  verifySubmissionSignals,
  registerSubmissionSession,
  resumeSubmission,
  activeSubmissions,
  closeSubmissionSession,
} from '../src/submitter/captchaResume.js';
import { captureWebProof } from '../src/submitter/proofCapture.js';
import { createServer } from '../src/server/index.js';
import { upsertApplication, getApplication } from '../src/db/applications.js';
import type { ResolvedField } from '../src/types/index.js';

const MOCK_FORM_HTML = `
<!DOCTYPE html>
<html>
<head><title>Job Application for Software Engineer at Acme Corp</title></head>
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

    <div class="field">
      <label for="phone">Phone *</label>
      <input type="text" id="phone" name="phone" />
    </div>

    <div class="field">
      <label for="job_application_location">Location</label>
      <input type="text" id="job_application_location" name="job_application[location]" />
    </div>

    <div class="field">
      <label for="cover_letter">Why do you want to work here?</label>
      <textarea id="cover_letter" name="cover_letter"></textarea>
    </div>

    <div class="field">
      <label for="gender">Gender</label>
      <select id="gender" name="job_application[gender]">
        <option value="">Select...</option>
        <option value="Male">Male</option>
        <option value="Female">Female</option>
        <option value="Decline">Decline To Self Identify</option>
      </select>
    </div>

    <fieldset>
      <legend>Are you authorized to work in the US?</legend>
      <label><input type="radio" name="work_auth" value="Yes" /> Yes</label>
      <label><input type="radio" name="work_auth" value="No" /> No</label>
    </fieldset>

    <div class="field">
      <label><input type="checkbox" id="terms" name="terms" /> I agree to terms</label>
    </div>

    <div class="field">
      <label for="resume">Resume/CV *</label>
      <input type="file" id="resume" name="resume" />
    </div>

    <button type="submit" id="submit_app">Submit Application</button>
  </form>

  <script>
    document.getElementById('application_form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.body.innerHTML = '<h1>Thank you for applying!</h1><p>Your application has been submitted successfully. Track your application status in your email.</p>';
      document.title = 'Thank you for applying - Acme Corp';
    });
  </script>
</body>
</html>
`;

const MOCK_CAPTCHA_HTML = `
<!DOCTYPE html>
<html>
<head><title>Job Application with Security Check</title></head>
<body>
  <form id="application_form">
    <label for="first_name">First Name</label>
    <input type="text" id="first_name" name="first_name" />
    
    <div class="cf-turnstile">
      <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>
    </div>

    <button type="submit" id="submit_app">Submit Application</button>
  </form>
</body>
</html>
`;

async function runSubmissionsTestSuite() {
  console.log('🧪 Starting Phase V2-4 Submissions & Playwright Engine Tests...\n');

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

  // 1. Setup local Mock HTTP Server serving HTML fixtures
  const mockHttpServer = http.createServer((req, res) => {
    if (req.url === '/captcha-job') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_CAPTCHA_HTML);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_FORM_HTML);
    }
  });

  await new Promise<void>((resolve) => mockHttpServer.listen(0, resolve));
  const mockPort = (mockHttpServer.address() as any).port;
  const mockFormUrl = `http://localhost:${mockPort}/job-form`;
  const mockCaptchaUrl = `http://localhost:${mockPort}/captcha-job`;

  // 2. Setup Express API server instance
  const apiApp = createServer();
  const apiServer = apiApp.listen(0);
  const apiPort = (apiServer.address() as any).port;
  const apiBaseUrl = `http://localhost:${apiPort}`;

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // =========================================================================
    // Test 1: Form Filler populates text, textarea, select, radio, checkbox, location
    // =========================================================================
    console.log('\n--- Test Group 1: Form Filler DOM Population ---');
    const page = await browser.newPage();
    await page.goto(mockFormUrl);

    const testResolvedFields: ResolvedField[] = [
      { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'John', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'last_name', name: 'last_name', type: 'text', label: 'Last Name', value: 'Doe', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'john.doe@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'phone', name: 'phone', type: 'text', label: 'Phone', value: '555-0199', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'location', name: 'job_application[location]', type: 'location_autocomplete', label: 'Location', value: 'San Francisco, CA', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'resume', name: 'resume', type: 'file', label: 'Resume', value: 'resumes/AWL-11_resume.pdf', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'cover_letter', name: 'cover_letter', type: 'textarea', label: 'Cover Letter', value: 'I have 5+ years of full stack experience.', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'gender', name: 'job_application[gender]', type: 'select', label: 'Gender', value: 'Male', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'work_auth', name: 'work_auth', type: 'radio', label: 'Work Authorization', value: 'Yes', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      { fieldId: 'terms', name: 'terms', type: 'checkbox', label: 'Terms Agreement', value: 'true', source: 'supabase', resolvedByTier: 1, confidence: 1 },
    ];

    const testApp = {
      id: 'test-app-1',
      applywizz_id: 'AWL-11',
      job_url: mockFormUrl,
      status: 'READY_FOR_REVIEW' as const,
      resolved_fields: testResolvedFields,
    };

    const fillSummary = await fillForm(page, testApp, { minJitterMs: 50, maxJitterMs: 100 });

    assert(fillSummary.totalFields === 10, 'Form Filler processed all 10 fields');
    assert(fillSummary.filledFields === 10, 'Form Filler filled 10/10 fields successfully');
    assert(fillSummary.failedFields === 0, 'Form Filler reported 0 failures');

    // Verify DOM values in page
    const firstNameVal = await page.inputValue('#first_name');
    const emailVal = await page.inputValue('#email');
    const textareaVal = await page.inputValue('#cover_letter');
    const selectVal = await page.inputValue('#gender');
    const radioChecked = await page.isChecked('input[type="radio"][value="Yes"]');
    const checkboxChecked = await page.isChecked('#terms');

    assert(firstNameVal === 'John', 'DOM input #first_name contains "John"');
    assert(emailVal === 'john.doe@example.com', 'DOM input #email contains "john.doe@example.com"');
    assert(textareaVal.includes('5+ years'), 'DOM textarea #cover_letter contains entered text');
    assert(selectVal === 'Male', 'DOM select #gender selected option "Male"');
    assert(radioChecked === true, 'DOM radio input "Yes" is checked');
    assert(checkboxChecked === true, 'DOM checkbox #terms is checked');

    // =========================================================================
    // Test 2: Submit Trigger & Multi-Signal Completion Verification
    // =========================================================================
    console.log('\n--- Test Group 2: Multi-Signal Confirmation Verification ---');
    await page.click('#submit_app');

    const verification = await verifySubmissionSignals(page, 5000);
    assert(verification.verified === true, 'Multi-signal verification confirmed successful submission');
    assert(verification.signal?.includes('Thank you for applying'), 'Verification matched confirmation signal');

    // =========================================================================
    // Test 3: CAPTCHA Detection
    // =========================================================================
    console.log('\n--- Test Group 3: CAPTCHA Detection Engine ---');
    const captchaPage = await browser.newPage();
    await captchaPage.goto(mockCaptchaUrl);

    const captchaResult = await detectCaptcha(captchaPage);
    assert(captchaResult.detected === true, 'CAPTCHA iframe detected on security check page');

    await captchaPage.close();
    await page.close();

    // =========================================================================
    // Test 4: Session Registration and Manual Resumption
    // =========================================================================
    console.log('\n--- Test Group 4: Session Resumption Workflow ---');
    const resumePage = await browser.newPage();
    await resumePage.goto(mockFormUrl);
    await fillForm(resumePage, testApp, { minJitterMs: 50, maxJitterMs: 100 });

    const resumeDbApp = await upsertApplication({
      applywizz_id: 'AWL-11',
      job_url: `${mockFormUrl}?resume=1`,
      company_name: 'Acme Corp',
      job_title: 'Software Engineer',
      status: 'CAPTCHA_REQUIRED',
      resolved_fields: testResolvedFields,
    });

    registerSubmissionSession({
      applicationId: resumeDbApp.id!,
      browser,
      context: resumePage.context(),
      page: resumePage,
      application: resumeDbApp,
      startedAt: Date.now(),
    });

    assert(activeSubmissions.has(resumeDbApp.id!), 'Active session registered in memory');

    const resumeResult = await resumeSubmission(resumeDbApp.id!);
    assert(resumeResult.status === 'APPLIED', 'Resumed submission transitioned to APPLIED');
    assert(!activeSubmissions.has(resumeDbApp.id!), 'Active session cleaned up after completion');

    // =========================================================================
    // Test 5: End-to-End Express Endpoints (Dry-Run, Submit, Proof)
    // =========================================================================
    console.log('\n--- Test Group 5: REST API Submissions Endpoints ---');

    // Seed test application in Supabase
    const dbApp = await upsertApplication({
      applywizz_id: 'AWL-11',
      job_url: mockFormUrl,
      company_name: 'Acme Corp',
      job_title: 'Software Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: testResolvedFields,
    });

    assert(dbApp !== null && Boolean(dbApp.id), 'Seeded application in candidate_applications');

    // 5a. POST /api/applications/:id/dry-run
    const dryRunRes = await fetch(`${apiBaseUrl}/api/applications/${dbApp.id}/dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless: true }), // Run headless during automated test
    });

    assert(dryRunRes.status === 200, `POST /dry-run returned 200 (got ${dryRunRes.status})`);
    const dryRunJson: any = await dryRunRes.json();
    assert(dryRunJson.success === true, 'POST /dry-run response success is true');
    assert(dryRunJson.summary?.filledFields >= 8, 'POST /dry-run filled fields correctly');

    // 5b. POST /api/applications/:id/submit
    const submitRes = await fetch(`${apiBaseUrl}/api/applications/${dbApp.id}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headless: true }),
    });

    assert(submitRes.status === 200, `POST /submit returned 200 (got ${submitRes.status})`);
    const submitJson: any = await submitRes.json();
    assert(submitJson.status === 'APPLIED', 'POST /submit returned status "APPLIED"');
    assert(Boolean(submitJson.proofWebUrl), 'POST /submit returned proofWebUrl');

    // 5c. GET /api/applications/:id/proof
    const proofRes = await fetch(`${apiBaseUrl}/api/applications/${dbApp.id}/proof`);
    assert(proofRes.status === 200, `GET /proof returned 200 (got ${proofRes.status})`);
    const proofJson: any = await proofRes.json();
    assert(proofJson.status === 'APPLIED', 'GET /proof returns status "APPLIED"');
    assert(Boolean(proofJson.proofWebUrl), 'GET /proof returns valid proofWebUrl');

    console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);

    if (passed === total) {
      console.log('🎉 All Phase V2-4 Submissions tests passed successfully!');
    } else {
      console.error('❌ Some tests failed.');
      process.exit(1);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise<void>((resolve) => mockHttpServer.close(() => resolve()));
    apiServer.close();
  }
}

runSubmissionsTestSuite().catch((err) => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
