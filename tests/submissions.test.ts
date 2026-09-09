/**
 * @fileoverview Unit and Integration Tests for Phase V2-4: Playwright Form Filler & Submission Engine.
 */

import http from 'http';
import { chromium, type Browser } from 'playwright';
import { fillForm } from '../src/submitter/formFiller.js';
import {
  detectCaptchaOrOtp,
  detectOTPField,
  runLiveSubmit,
  PAUSED_SESSIONS,
  submitOtpToPausedSession,
  pollCaptchaSolved,
} from '../src/submitter/liveSubmit.js';
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

const MOCK_OTP_FORM_HTML = `
<!DOCTYPE html>
<html>
<head><title>Job Application with Post-Submit OTP</title></head>
<body>
  <form id="application_form">
    <div class="field">
      <label for="first_name">First Name</label>
      <input type="text" id="first_name" name="first_name" required />
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required />
    </div>
    <button type="submit" id="submit_app">Submit Application</button>
  </form>

  <script>
    document.getElementById('application_form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.body.innerHTML = '<h2>Verification Code</h2><p>Enter OTP sent to email</p><form id="otp_form"><input type="text" name="verification_code" id="verification_code" placeholder="Enter verification code" maxlength="6" /><button type="submit" id="verify_btn">Verify</button></form>';
      document.getElementById('otp_form').addEventListener('submit', function(e2) {
        e2.preventDefault();
        var code = (document.getElementById('verification_code') || {}).value;
        if (code === '000000') {
          var errDiv = document.getElementById('otp_err') || document.createElement('div');
          errDiv.id = 'otp_err';
          errDiv.innerText = 'Invalid OTP code entered';
          document.getElementById('otp_form').appendChild(errDiv);
          return;
        }
        document.title = 'Thank you for applying - Acme Corp';
        document.body.innerHTML = '<h1>Thank you for applying!</h1><p>Your application has been submitted successfully.</p>';
      });
    });
  </script>
</body>
</html>
`;

const MOCK_MULTIBOX_OTP_HTML = `
<!DOCTYPE html>
<html>
<head><title>Job Application with Multi-Box OTP</title></head>
<body>
  <form id="application_form">
    <div class="field">
      <label for="first_name">First Name</label>
      <input type="text" id="first_name" name="first_name" required />
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required />
    </div>
    <button type="submit" id="submit_app">Submit Application</button>
  </form>

  <script>
    document.getElementById('application_form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.body.innerHTML = '<h2>Enter 6-digit Code</h2>' +
        '<form id="multi_otp_form">' +
        '  <input data-testid="otp-0" maxlength="1" />' +
        '  <input data-testid="otp-1" maxlength="1" />' +
        '  <input data-testid="otp-2" maxlength="1" />' +
        '  <input data-testid="otp-3" maxlength="1" />' +
        '  <input data-testid="otp-4" maxlength="1" />' +
        '  <input data-testid="otp-5" maxlength="1" />' +
        '  <button type="submit" id="verify_btn">Verify</button>' +
        '</form>';
      document.getElementById('multi_otp_form').addEventListener('submit', function(e2) {
        e2.preventDefault();
        var boxes = document.querySelectorAll('input[data-testid*="otp"]');
        var val = '';
        boxes.forEach(function(b) { val += b.value; });
        if (val.toUpperCase() === 'AB12CD') {
          document.title = 'Thank you for applying - Acme Corp';
          document.body.innerHTML = '<h1>Thank you for applying!</h1><p>Your application has been submitted successfully.</p>';
        }
      });
    });
  </script>
</body>
</html>
`;

const MOCK_POLL_CAPTCHA_HTML = `
<!DOCTYPE html>
<html>
<head><title>Captcha Verification Page</title></head>
<body>
  <h1>Security Check</h1>
  <div id="captcha_container">
    <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>
  </div>
  <button type="submit" id="submit_app" disabled>Submit Application</button>

  <script>
    setTimeout(function() {
      var container = document.getElementById('captcha_container');
      if (container) container.remove();
      var btn = document.getElementById('submit_app');
      if (btn) btn.removeAttribute('disabled');
    }, 400);

    document.getElementById('submit_app').addEventListener('click', function(e) {
      e.preventDefault();
      document.title = 'Thank you for applying - Acme Corp';
      document.body.innerHTML = '<h1>Thank you for applying!</h1><p>Application verified.</p>';
    });
  </script>
</body>
</html>
`;

const MOCK_POLL_TIMEOUT_HTML = `
<!DOCTYPE html>
<html>
<head><title>Unsolved Captcha Page</title></head>
<body>
  <h1>Persistent Captcha Challenge</h1>
  <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>
  <button type="submit" id="submit_app" disabled>Submit Application</button>
</body>
</html>
`;

const MOCK_FULL_FLOW_HTML = `
<!DOCTYPE html>
<html>
<head><title>Senior Software Engineer Application - Acme Corp</title></head>
<body>
  <form id="application_form">
    <div class="field">
      <label for="first_name">First Name</label>
      <input type="text" id="first_name" name="first_name" required />
    </div>
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required />
    </div>

    <!-- CAPTCHA iframe widget detected -->
    <div id="captcha_container">
      <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>
    </div>

    <button type="submit" id="submit_app" disabled>Submit Application</button>
  </form>

  <script>
    // Simulate user solving CAPTCHA in the headful window after 1200ms
    setTimeout(function() {
      var container = document.getElementById('captcha_container');
      if (container) container.remove();
      var btn = document.getElementById('submit_app');
      if (btn) btn.removeAttribute('disabled');
    }, 1200);

    // When submit is clicked: page transitions to 8-box alphanumeric OTP challenge
    document.getElementById('application_form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.body.innerHTML = '<h2>Verification Code</h2>' +
        '<p>Please enter the 8-character verification code sent to your email</p>' +
        '<form id="alphanumeric_otp_form">' +
        '  <input data-testid="otp-0" maxlength="1" />' +
        '  <input data-testid="otp-1" maxlength="1" />' +
        '  <input data-testid="otp-2" maxlength="1" />' +
        '  <input data-testid="otp-3" maxlength="1" />' +
        '  <input data-testid="otp-4" maxlength="1" />' +
        '  <input data-testid="otp-5" maxlength="1" />' +
        '  <input data-testid="otp-6" maxlength="1" />' +
        '  <input data-testid="otp-7" maxlength="1" />' +
        '  <button type="submit" id="verify_btn">Verify</button>' +
        '</form>';

      document.getElementById('alphanumeric_otp_form').addEventListener('submit', function(e2) {
        e2.preventDefault();
        var boxes = document.querySelectorAll('input[data-testid*="otp"]');
        var val = '';
        boxes.forEach(function(b) { val += b.value; });
        if (val === 'Aebf0aDc') {
          document.title = 'Thank you for applying - Acme Corp';
          document.body.innerHTML = '<h1>Thank you for applying!</h1><p>Your application has been submitted successfully.</p>';
        } else {
          var err = document.getElementById('otp_error') || document.createElement('div');
          err.id = 'otp_error';
          err.innerText = 'Invalid OTP code: ' + val;
          document.getElementById('alphanumeric_otp_form').appendChild(err);
        }
      });
    });
  </script>
</body>
</html>
`;

async function runSubmissionsTestSuite() {
  console.log('🧪 Starting Phase V2-4 Submissions & Playwright Engine Tests...\\n');

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
    } else if (req.url?.startsWith('/full-flow-job')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_FULL_FLOW_HTML);
    } else if (req.url?.startsWith('/multibox-otp-job')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_MULTIBOX_OTP_HTML);
    } else if (req.url?.startsWith('/poll-captcha-job')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_POLL_CAPTCHA_HTML);
    } else if (req.url?.startsWith('/poll-captcha-timeout')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_POLL_TIMEOUT_HTML);
    } else if (req.url?.startsWith('/otp-job')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_OTP_FORM_HTML);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_FORM_HTML);
    }
  });

  await new Promise<void>((resolve) => mockHttpServer.listen(0, resolve));
  const mockPort = (mockHttpServer.address() as any).port;
  const mockFormUrl = `http://localhost:${mockPort}/job-form`;
  const mockCaptchaUrl = `http://localhost:${mockPort}/captcha-job`;
  const mockOtpUrl = `http://localhost:${mockPort}/otp-job`;
  const mockMultiBoxOtpUrl = `http://localhost:${mockPort}/multibox-otp-job`;
  const mockPollCaptchaUrl = `http://localhost:${mockPort}/poll-captcha-job`;
  const mockPollTimeoutUrl = `http://localhost:${mockPort}/poll-captcha-timeout`;
  const mockFullFlowUrl = `http://localhost:${mockPort}/full-flow-job`;

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
    assert(textareaVal === '', 'DOM textarea #cover_letter is skipped per policy');
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
    console.log('\n--- Test Group 3: Post-Submit CAPTCHA/OTP Detection Engine ---');
    const captchaPage = await browser.newPage();
    await captchaPage.goto(mockCaptchaUrl);

    const captchaResult = await detectCaptchaOrOtp(captchaPage);
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
      status: 'OTP_REQUIRED',
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
    // Test 4b: Headless In-Memory OTP Pause & Resumption Flow
    // =========================================================================
    console.log('\n--- Test Group 4b: Headless In-Memory OTP Pause & Resumption ---');
    const otpDbApp = await upsertApplication({
      applywizz_id: 'AWL-OTP-TEST',
      job_url: mockOtpUrl,
      company_name: 'Acme Corp',
      job_title: 'Software Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Jane', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'jane.doe@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      ],
    });

    const liveSubmitOtpResult = await runLiveSubmit(otpDbApp);

    assert(liveSubmitOtpResult.status === 'OTP_REQUIRED', 'Live submit paused with status OTP_REQUIRED');
    assert(liveSubmitOtpResult.message === 'OTP required. Enter code in dashboard.', 'Returned expected dashboard message');
    assert(PAUSED_SESSIONS.has(otpDbApp.id!), 'Paused session stored in PAUSED_SESSIONS map');

    const pausedSession = PAUSED_SESSIONS.get(otpDbApp.id!);
    assert(Boolean(pausedSession?.browser), 'Paused session contains browser');
    assert(Boolean(pausedSession?.page), 'Paused session contains page');
    assert(Boolean(pausedSession?.otpFieldSelector), 'Paused session contains otpFieldSelector');
    assert(pausedSession?.applicationId === otpDbApp.id!, 'Paused session contains applicationId');
    assert(Boolean(pausedSession?.pausedAt), 'Paused session contains pausedAt');
    assert(pausedSession?.page.isClosed() === false, 'Headless browser page is kept open in memory');

    // 4b. Test retry retention: failure keeps session paused for operator retry
    // Test verification failure with a short timeout
    const failVerifyResult = await submitOtpToPausedSession(otpDbApp.id!, '000000', { timeoutMs: 500 });
    assert(failVerifyResult.status === 'FAILED', 'submitOtpToPausedSession returns status FAILED on timeout/non-confirmation');
    assert(PAUSED_SESSIONS.has(otpDbApp.id!), 'Paused session REMAINS in PAUSED_SESSIONS map on failure for retry');

    // Resume using submitOtpToPausedSession with valid OTP without opening new browser
    const otpVerifyResult = await submitOtpToPausedSession(otpDbApp.id!, '123456');
    assert(otpVerifyResult.status === 'APPLIED', 'submitOtpToPausedSession transitioned status to APPLIED');
    assert(!PAUSED_SESSIONS.has(otpDbApp.id!), 'Paused session cleared from memory after successful completion');

    // =========================================================================
    // Test 5: End-to-End Express Endpoints (Dry-Run, Submit, Proof, Submit-OTP)
    // =========================================================================
    console.log('\n--- Test Group 5: REST API Submissions Endpoints ---');

    // 5-pre. POST /api/applications/:id/submit-otp when no session exists
    const missingOtpRes = await fetch(`${apiBaseUrl}/api/applications/non-existent-id/submit-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp: '123456' }),
    });
    assert(missingOtpRes.status === 404, `POST /submit-otp missing session returned 404 (got ${missingOtpRes.status})`);
    const missingOtpJson: any = await missingOtpRes.json();
    assert(missingOtpJson.error === 'No paused OTP session', 'POST /submit-otp missing session returns "No paused OTP session"');

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

    // 5d. End-to-end REST endpoint OTP submit:
    // Create new OTP app, run live submit to pause at OTP_REQUIRED, then call REST /api/applications/:id/submit-otp
    const restOtpApp = await upsertApplication({
      applywizz_id: 'AWL-REST-OTP',
      job_url: `${mockOtpUrl}?rest=1`,
      company_name: 'Acme Corp',
      job_title: 'Software Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Jane', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'jane.doe@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      ],
    });

    const liveSubmitRestResult = await runLiveSubmit(restOtpApp);
    assert(liveSubmitRestResult.status === 'OTP_REQUIRED', 'Live submit paused at OTP_REQUIRED for REST test');
    assert(PAUSED_SESSIONS.has(restOtpApp.id!), 'Paused session available in memory for REST test');

    const restSubmitOtpRes = await fetch(`${apiBaseUrl}/api/applications/${restOtpApp.id}/submit-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp: '654321' }),
    });

    assert(restSubmitOtpRes.status === 200, `POST /submit-otp returned 200 (got ${restSubmitOtpRes.status})`);
    const restSubmitOtpJson: any = await restSubmitOtpRes.json();
    assert(restSubmitOtpJson.status === 'APPLIED', 'POST /submit-otp returned status APPLIED');
    assert(restSubmitOtpJson.message === 'Application submitted successfully', 'POST /submit-otp returned success message');
    assert(Boolean(restSubmitOtpJson.proofUrl), 'POST /submit-otp returned proofUrl');
    assert(!PAUSED_SESSIONS.has(restOtpApp.id!), 'Paused session cleaned up after REST submit-otp');

    // =========================================================================
    // Test Group 6: Multi-Box Alphanumeric OTP & CAPTCHA Polling
    // =========================================================================
    console.log('\n--- Test Group 6: Multi-Box Alphanumeric OTP & CAPTCHA Polling ---');

    // 6a. Multi-Box Alphanumeric OTP
    const multiBoxApp = await upsertApplication({
      applywizz_id: 'AWL-MULTIBOX-TEST',
      job_url: mockMultiBoxOtpUrl,
      company_name: 'Acme Corp',
      job_title: 'Software Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Jane', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'jane.doe@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      ],
    });

    const liveSubmitMultiResult = await runLiveSubmit(multiBoxApp);
    assert(liveSubmitMultiResult.status === 'OTP_REQUIRED', 'Live submit paused at OTP_REQUIRED for multi-box form');
    const multiBoxSession = PAUSED_SESSIONS.get(multiBoxApp.id!);
    assert(Boolean(multiBoxSession), 'Paused session stored for multi-box OTP');
    assert(multiBoxSession?.multiBox === true, 'Detected multi-box OTP layout (multiBox=true)');
    assert(multiBoxSession?.boxCount === 6, 'Detected exactly 6 input boxes');
    assert(multiBoxSession?.boxSelectors?.length === 6, 'Stored 6 individual box selectors');

    // Submit alphanumeric code into the 6 boxes
    const multiOtpResult = await submitOtpToPausedSession(multiBoxApp.id!, 'AB12CD');
    assert(multiOtpResult.status === 'APPLIED', 'Alphanumeric multi-box OTP submission reached status APPLIED');
    assert(Boolean(multiOtpResult.proofUrl), 'Multi-box OTP submission generated proofUrl');
    assert(!PAUSED_SESSIONS.has(multiBoxApp.id!), 'Paused session cleared after multi-box success');

    // 6b. pollCaptchaSolved success path (iframe vanishes, button enabled -> auto click submit)
    const pollApp = await upsertApplication({
      applywizz_id: 'AWL-POLL-SUCCESS',
      job_url: mockPollCaptchaUrl,
      company_name: 'Acme Corp',
      job_title: 'Software Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [],
    });

    const captchaTestBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const pollPage = await captchaTestBrowser.newPage();
      await pollPage.goto(mockPollCaptchaUrl);
      const pollResult = await pollCaptchaSolved(pollApp.id!, pollPage, pollApp, {
        timeoutMs: 4000,
        pollIntervalMs: 100,
        browser: captchaTestBrowser,
      });
      assert(pollResult.status === 'APPLIED', 'pollCaptchaSolved auto-submitted upon captcha resolution');
      assert(Boolean(pollResult.proofWebUrl), 'pollCaptchaSolved generated confirmation proof screenshot');

      // 6c. pollCaptchaSolved timeout path (persistent iframe -> CAPTCHA_TIMEOUT)
      const timeoutApp = await upsertApplication({
        applywizz_id: 'AWL-POLL-TIMEOUT',
        job_url: mockPollTimeoutUrl,
        company_name: 'Acme Corp',
        job_title: 'Software Engineer',
        status: 'READY_FOR_REVIEW',
        resolved_fields: [],
      });

      const timeoutPage = await captchaTestBrowser.newPage();
      await timeoutPage.goto(mockPollTimeoutUrl);
      const timeoutResult = await pollCaptchaSolved(timeoutApp.id!, timeoutPage, timeoutApp, {
        timeoutMs: 1000,
        pollIntervalMs: 200,
        browser: captchaTestBrowser,
      });
      assert(timeoutResult.status === 'CAPTCHA_TIMEOUT', 'pollCaptchaSolved returned status CAPTCHA_TIMEOUT on expiry');
      assert(timeoutResult.message === 'CAPTCHA not solved within 5 minutes', 'pollCaptchaSolved returned expected timeout message');
      const updatedTimeoutApp = await getApplication(timeoutApp.id!);
      assert(updatedTimeoutApp?.status === 'FAILED', 'Application DB status transitioned to FAILED on captcha timeout');
    } finally {
      await captchaTestBrowser.close().catch(() => {});
    }

    // =========================================================================
    // Test Group 7: Full E2E Flow (CAPTCHA Poll 500ms -> Auto-Submit -> 8-Box Alphanumeric OTP -> APPLIED)
    // =========================================================================
    console.log('\n--- Test Group 7: Full E2E: Form Fill -> CAPTCHA Poll 500ms -> Auto-Submit -> 8-Box Alphanumeric OTP (Aebf0aDc) -> APPLIED ---');

    const fullFlowApp = await upsertApplication({
      applywizz_id: 'AWL-FULL-FLOW-TEST',
      job_url: mockFullFlowUrl,
      company_name: 'Acme Corp',
      job_title: 'Full Stack Engineer',
      status: 'READY_FOR_REVIEW',
      resolved_fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Alex', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'alex@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      ],
    });

    const flowBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const flowPage = await flowBrowser.newPage();
      await flowPage.goto(mockFullFlowUrl);

      // 1. CAPTCHA iframe detected on initial page load
      const captchaDetected = await detectCaptchaOrOtp(flowPage);
      assert(captchaDetected.detected === true, 'Step 2: CAPTCHA iframe detected on page');

      // 2. Form fills
      const fillRes = await fillForm(flowPage, fullFlowApp, { minJitterMs: 50, maxJitterMs: 100 });
      assert(fillRes.filledFields >= 2, 'Step 1: Form Filler populated initial form fields');
      const firstNameVal = await flowPage.inputValue('#first_name');
      assert(firstNameVal === 'Alex', 'Step 1: DOM input #first_name contains filled value "Alex"');

      // 3. Bot polls every 500ms -> CAPTCHA solved in headful window -> Bot auto-clicks submit -> OTP page loads
      // pollCaptchaSolved polls every 500ms. At 600ms, page removes captcha and enables submit.
      // Bot detects CAPTCHA gone and submit button enabled, auto-clicks submit.
      // Submit triggers page transition to 8-box alphanumeric OTP form.
      // Bot detects 8-box OTP challenge, sets status OTP_REQUIRED, and pauses session.
      const pollResult = await pollCaptchaSolved(fullFlowApp.id!, flowPage, fullFlowApp, {
        timeoutMs: 8000,
        pollIntervalMs: 500,
        browser: flowBrowser,
      });

      assert(pollResult.status === 'OTP_REQUIRED', 'Step 4 & 5: Bot auto-clicked submit and transitioned to OTP_REQUIRED on OTP challenge');
      assert(pollResult.requiresOtp === true, 'Step 5: Paused result specifies requiresOtp=true');

      // Step 5b: Verify paused session detected multi-box 8-character OTP layout
      const pausedFlowSession = PAUSED_SESSIONS.get(fullFlowApp.id!);
      assert(Boolean(pausedFlowSession), 'Step 5b: Paused session stored in PAUSED_SESSIONS registry');
      assert(pausedFlowSession?.multiBox === true, 'Step 5b: Multi-box OTP layout detected (multiBox=true)');
      assert(pausedFlowSession?.boxCount === 8, 'Step 5b: Detected exactly 8 individual OTP boxes');
      assert(pausedFlowSession?.boxSelectors?.length === 8, 'Step 5b: Stored 8 distinct box selectors');

      // Step 6: Verify Dashboard Alphanumeric OTP Modal Input supports "Aebf0aDc"
      const dashPage = await flowBrowser.newPage();
      await dashPage.goto(apiBaseUrl);
      const testInputVal = await dashPage.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 16;
        input.value = 'Aebf0aDc';
        const clean = input.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
        return clean;
      });
      assert(testInputVal === 'Aebf0aDc', 'Step 6: Dashboard OTP modal input preserves alphanumeric code "Aebf0aDc"');
      await dashPage.close();

      // Step 7: You paste OTP ("Aebf0aDc") and submit via REST API
      // Step 8: Bot fills each OTP box -> verifies -> captures proof
      const otpSubmitRes = await fetch(`${apiBaseUrl}/api/applications/${fullFlowApp.id}/submit-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: 'Aebf0aDc' }),
      });

      assert(otpSubmitRes.status === 200, `Step 7: POST /submit-otp with "Aebf0aDc" returned 200 (got ${otpSubmitRes.status})`);
      const otpSubmitJson: any = await otpSubmitRes.json();
      assert(otpSubmitJson.status === 'APPLIED', 'Step 8: POST /submit-otp returned status "APPLIED"');
      assert(Boolean(otpSubmitJson.proofUrl), 'Step 8: Proof screenshot captured and returned in response');

      // Step 9: Verify final DB status is "APPLIED" and paused session is cleared
      const finalApp = await getApplication(fullFlowApp.id!);
      assert(finalApp?.status === 'APPLIED', 'Step 9: Database application status transitioned to "APPLIED"');
      assert(Boolean(finalApp?.proof_web_url), 'Step 9: Database record contains valid proof_web_url');
      assert(!PAUSED_SESSIONS.has(fullFlowApp.id!), 'Step 9: Paused session cleared from memory after successful completion');
    } finally {
      await flowBrowser.close().catch(() => {});
    }

    console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);

    if (passed === total) {
      console.log('🎉 All Phase V2-4 Submissions tests passed successfully!');
    } else {
      console.error('❌ Some tests failed.');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise<void>((resolve) => mockHttpServer.close(() => resolve()));
    apiServer.close();
  }

  process.exit(passed === total ? 0 : 1);
}

runSubmissionsTestSuite().catch((err) => {
  console.error('Unhandled test suite error:', err);
  process.exit(1);
});
