/**
 * @fileoverview Automated Test Suite for Phase V2-5: Web Proof Capture & Status Lifecycle.
 *
 * Verifies:
 * 1. Database status transitions and persistence (`setProofUrl`, `updateStatus`, `setDryRunScreenshotUrl`)
 * 2. Web proof screenshot capture & Supabase Storage upload (`captureWebProof`)
 * 3. Express REST API `GET /api/applications/:id` returning complete status and proof metadata
 * 4. Polling workflow simulation during `APPLYING` state transition to `APPLIED`
 * 5. Full lifecycle state machine integrity (`READY_FOR_REVIEW` -> `DRY_RUN_COMPLETE` -> `APPLYING` -> `APPLIED` / `FAILED` / `CAPTCHA_REQUIRED`)
 */

import http from 'http';
import { chromium, type Browser } from 'playwright';
import { createServer } from '../src/server/index.js';
import {
  upsertApplication,
  getApplication,
  updateStatus,
  setProofUrl,
  setDryRunScreenshotUrl,
  type ApplicationStatus,
} from '../src/db/applications.js';
import { captureWebProof } from '../src/submitter/proofCapture.js';
import { getDbClient } from '../src/db/client.js';

const MOCK_CONFIRMATION_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Thank you for applying - Global Tech Corp</title>
  <style>
    body { font-family: sans-serif; padding: 40px; background: #f8fafc; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); max-width: 600px; margin: 0 auto; text-align: center; }
    h1 { color: #059669; }
    p { color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎉 Application Submitted Successfully!</h1>
    <p>Thank you for applying to Global Tech Corp. We have received your application.</p>
    <p>Our talent acquisition team will review your profile and contact you soon.</p>
  </div>
</body>
</html>
`;

async function runProofLifecycleTestSuite() {
  console.log('🧪 Starting Phase V2-5 Web Proof Capture & Status Lifecycle Tests...\n');

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

  // 1. Setup local Mock HTTP Server serving HTML confirmation fixture
  const mockHttpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(MOCK_CONFIRMATION_HTML);
  });

  await new Promise<void>((resolve) => mockHttpServer.listen(0, resolve));
  const mockPort = (mockHttpServer.address() as any).port;
  const mockConfirmationUrl = `http://localhost:${mockPort}/confirmation`;

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
    // Test Group 1: Database Status Lifecycle & Methods
    // =========================================================================
    console.log('\n--- Test Group 1: Database Status Lifecycle Operations ---');

    const testCandidateId = 'AWL-11';
    const testJobUrl = `https://job-boards.greenhouse.io/acme/jobs/${Date.now()}`;

    // Seed application
    const seeded = await upsertApplication({
      applywizz_id: testCandidateId,
      job_url: testJobUrl,
      company_name: 'Acme Corp',
      job_title: 'Senior Platform Engineer',
      resolved_fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'Alice', source: 'supabase', resolvedByTier: 1, confidence: 1 },
      ],
    });

    assert(seeded.status === 'READY_FOR_REVIEW', 'Application initializes in READY_FOR_REVIEW status');
    assert(seeded.id !== undefined, 'Application record assigned unique UUID');
    const recordId = seeded.id!;

    // Test transition to DRY_RUN_COMPLETE
    const mockDryRunUrl = 'https://storage.supabase.co/proofs_dry_run/dryrun_test.png';
    await setDryRunScreenshotUrl(recordId, mockDryRunUrl);
    await updateStatus(recordId, 'DRY_RUN_COMPLETE');

    let updated = await getApplication(recordId);
    assert(updated?.status === 'DRY_RUN_COMPLETE', 'Application transitioned to DRY_RUN_COMPLETE status');
    assert(updated?.dry_run_screenshot_url === mockDryRunUrl, 'dry_run_screenshot_url persisted correctly');

    // Test transition to APPLYING
    await updateStatus(recordId, 'APPLYING');
    updated = await getApplication(recordId);
    assert(updated?.status === 'APPLYING', 'Application transitioned to APPLYING status');

    // Test setProofUrl and transition to APPLIED
    const mockProofUrl = 'https://storage.supabase.co/proofs_web/proofs/test_web.png';
    const captureTimestamp = new Date().toISOString();
    await setProofUrl(recordId, mockProofUrl, captureTimestamp);
    await updateStatus(recordId, 'APPLIED');

    updated = await getApplication(recordId);
    assert(updated?.status === 'APPLIED', 'Application transitioned to APPLIED status');
    assert(updated?.proof_web_url === mockProofUrl, 'proof_web_url persisted correctly in DB');
    assert(updated?.proof_captured_at !== null, 'proof_captured_at timestamp persisted in DB');
    assert(updated?.submitted_at !== null, 'submitted_at timestamp populated on APPLIED');

    // Test transition to FAILED with error message
    await updateStatus(recordId, 'FAILED', 'Form submission timed out');
    updated = await getApplication(recordId);
    assert(updated?.status === 'FAILED', 'Application transitioned to FAILED status');
    assert(updated?.error_message === 'Form submission timed out', 'error_message persisted on FAILED');

    // Test transition to CAPTCHA_REQUIRED
    await updateStatus(recordId, 'CAPTCHA_REQUIRED');
    updated = await getApplication(recordId);
    assert(updated?.status === 'CAPTCHA_REQUIRED', 'Application transitioned to CAPTCHA_REQUIRED status');

    // =========================================================================
    // Test Group 2: Web Proof Capture & Storage Upload
    // =========================================================================
    console.log('\n--- Test Group 2: Web Proof Screenshot Capture Engine ---');

    const page = await browser.newPage();
    await page.goto(mockConfirmationUrl);

    // Capture confirmation proof
    const proofResult = await captureWebProof(page, recordId);

    assert(typeof proofResult.proofWebUrl === 'string' && proofResult.proofWebUrl.length > 0, 'captureWebProof returns proofWebUrl');
    assert(typeof proofResult.url === 'string' && proofResult.url.length > 0, 'captureWebProof returns alias url');
    assert(typeof proofResult.proofCapturedAt === 'string', 'captureWebProof returns proofCapturedAt');
    assert(typeof proofResult.capturedAt === 'string', 'captureWebProof returns alias capturedAt');
    assert(proofResult.proofWebUrl.includes('proofs_web'), 'proofWebUrl references proofs_web storage bucket');

    // Verify DB update from captureWebProof
    const dbApp = await getApplication(recordId);
    assert(dbApp?.proof_web_url === proofResult.proofWebUrl, 'captureWebProof automatically updated DB proof_web_url');
    assert(dbApp?.proof_captured_at !== null, 'captureWebProof automatically updated DB proof_captured_at');

    await page.close();

    // =========================================================================
    // Test Group 3: REST API GET /api/applications/:id
    // =========================================================================
    console.log('\n--- Test Group 3: REST API Applications Endpoints ---');

    // Set to APPLIED for API verification
    await updateStatus(recordId, 'APPLIED');

    const getRes = await fetch(`${apiBaseUrl}/api/applications/${recordId}`);
    assert(getRes.status === 200, `GET /api/applications/:id returned 200 (got ${getRes.status})`);

    const appJson = await getRes.json();
    assert(appJson.id === recordId, 'API returns correct application id');
    assert(appJson.status === 'APPLIED', 'API returns status: "APPLIED"');
    assert(appJson.proof_web_url === proofResult.proofWebUrl, 'API returns full proof_web_url');
    assert(appJson.proof_captured_at !== null, 'API returns proof_captured_at');
    assert(appJson.dry_run_screenshot_url === mockDryRunUrl, 'API returns dry_run_screenshot_url');
    assert(Array.isArray(appJson.resolved_fields), 'API returns resolved_fields array');

    // Lookup by applywizz_id
    const candGetRes = await fetch(`${apiBaseUrl}/api/applications/${testCandidateId}`);
    assert(candGetRes.status === 200, 'GET /api/applications/:id supports candidate applywizz_id lookup');
    const candJson = await candGetRes.json();
    assert(candJson.applywizz_id === testCandidateId, 'Candidate lookup returns matching record');

    // Non-existent ID lookup
    const notFoundRes = await fetch(`${apiBaseUrl}/api/applications/non-existent-id-9999`);
    assert(notFoundRes.status === 404, 'GET /api/applications/:id returns 404 for non-existent record');

    // =========================================================================
    // Test Group 4: Polling Simulation Workflow
    // =========================================================================
    console.log('\n--- Test Group 4: Polling Workflow Simulation ---');

    // Set application to APPLYING
    await updateStatus(recordId, 'APPLYING');

    // Poll 1: Confirm status is APPLYING
    let pollRes = await fetch(`${apiBaseUrl}/api/applications/${recordId}`);
    let pollData = await pollRes.json();
    assert(pollData.status === 'APPLYING', 'Polling step 1: Status is APPLYING');

    // Simulate backend submission completion after delay
    await setProofUrl(recordId, mockProofUrl);
    await updateStatus(recordId, 'APPLIED');

    // Poll 2: Confirm status transitions to APPLIED
    pollRes = await fetch(`${apiBaseUrl}/api/applications/${recordId}`);
    pollData = await pollRes.json();
    assert(pollData.status === 'APPLIED', 'Polling step 2: Status transitioned to APPLIED');
    assert(pollData.proof_web_url === mockProofUrl, 'Polling step 2: Proof URL immediately available');

  } finally {
    if (browser) await browser.close();
    mockHttpServer.close();
    apiServer.close();
  }

  console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);
  if (passed === total) {
    console.log('🎉 All Phase V2-5 Proof Capture & Status Lifecycle tests passed successfully!\n');
    process.exit(0);
  } else {
    console.error('❌ Some tests failed.\n');
    process.exit(1);
  }
}

runProofLifecycleTestSuite().catch((err) => {
  console.error('Fatal error during test suite:', err);
  process.exit(1);
});
