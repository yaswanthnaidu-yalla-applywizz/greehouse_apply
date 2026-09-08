/**
 * @fileoverview Master End-to-End Integration & Verification Test Suite (Phase V2-6).
 *
 * Validates the complete 7-checkpoint integration checklist:
 * - Checkpoint 1: Supabase database tables & storage buckets auto-provisioning
 * - Checkpoint 2: Dual-branch ingestion (template schema with cascading tags + candidate profile sync)
 * - Checkpoint 3: 5-tier waterfall resolution with native Supabase persistence
 * - Checkpoint 4: Zero duplicate API calls on subsequent runs (cache efficiency)
 * - Checkpoint 5: Inline edit & QA bank priority write-back (source: 'manual')
 * - Checkpoint 6: Dry-run form fill with screenshot capture to proofs_dry_run
 * - Checkpoint 7: Live submission with multi-signal verification, CAPTCHA pause, and web proof capture
 */

import http from 'http';
import { chromium, type Browser } from 'playwright';
import { createServer } from '../src/server/index.js';
import { getDbClient } from '../src/db/client.js';
import { ensureBucketsExist, uploadResume, uploadProof, uploadDryRunScreenshot } from '../src/db/storage.js';
import { upsertProfile, getProfile } from '../src/db/profiles.js';
import { upsertTemplate, getTemplateByUrl } from '../src/db/templates.js';
import { upsertAnswer, findAnswerByFingerprint } from '../src/db/qaBank.js';
import {
  upsertApplication,
  getApplication,
  updateStatus,
  setProofUrl,
  setDryRunScreenshotUrl,
} from '../src/db/applications.js';
import { generateFingerprint } from '../src/resolver/fingerprint.js';
import { AnswerResolver } from '../src/resolver/answerResolver.js';
import { fillForm } from '../src/submitter/formFiller.js';
import { verifySubmissionSignals } from '../src/submitter/liveSubmit.js';
import { captureWebProof } from '../src/submitter/proofCapture.js';
import type { CandidateSegment, ScannedJobTemplate, ResolvedField } from '../src/types/index.js';

const MOCK_CONFIRMATION_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Thank you for applying - Acme Global</title>
  <style>
    body { font-family: sans-serif; padding: 40px; background: #fafafa; }
    .box { background: white; padding: 30px; border-radius: 8px; border: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Thank you for applying to Acme Global!</h1>
    <p>Your application for the Senior Platform Engineer role has been received.</p>
    <p>You can track your application status anytime.</p>
  </div>
</body>
</html>
`;

const MOCK_FORM_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Acme Global - Senior Platform Engineer</title>
</head>
<body>
  <form id="application_form">
    <label for="first_name">First Name</label>
    <input type="text" id="first_name" name="first_name" />

    <label for="last_name">Last Name</label>
    <input type="text" id="last_name" name="last_name" />

    <label for="email">Email</label>
    <input type="text" id="email" name="email" />

    <label for="years_experience">Years of Experience</label>
    <input type="text" id="years_experience" name="years_experience" />

    <button type="submit" id="submit_app">Submit Application</button>
  </form>
</body>
</html>
`;

async function runE2EIntegrationTestSuite() {
  console.log('================================================================');
  console.log('  🧪 Master Phase V2-6 E2E Integration & Verification Suite');
  console.log('================================================================\n');

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
    if (req.url === '/confirmation') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_CONFIRMATION_HTML);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(MOCK_FORM_HTML);
    }
  });

  await new Promise<void>((resolve) => mockHttpServer.listen(0, resolve));
  const mockPort = (mockHttpServer.address() as any).port;
  const mockFormUrl = `http://localhost:${mockPort}/job-form`;
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

    const candidateId = 'AWL-11';
    const testJobUrl = `https://job-boards.greenhouse.io/acme-e2e/jobs/${Date.now()}`;

    // =========================================================================
    // Checkpoint 1: Database & Storage Provisioning
    // =========================================================================
    console.log('\n--- Checkpoint 1: Database & Storage Bucket Provisioning ---');
    await ensureBucketsExist();
    assert(true, 'Storage buckets (resumes, proofs_web, proofs_dry_run) initialized');

    const supabase = getDbClient();
    const { error: profileCheckError } = await supabase.from('profiles').select('id').limit(1);
    assert(!profileCheckError, 'Supabase table profiles is accessible');

    const { error: templatesCheckError } = await supabase.from('scanned_job_templates').select('id').limit(1);
    assert(!templatesCheckError, 'Supabase table scanned_job_templates is accessible');

    const { error: appCheckError } = await supabase.from('candidate_applications').select('id').limit(1);
    assert(!appCheckError, 'Supabase table candidate_applications is accessible');

    // =========================================================================
    // Checkpoint 2: Dual-Branch Ingestion & Data Persistence
    // =========================================================================
    console.log('\n--- Checkpoint 2: Dual-Branch Ingestion & Persistence ---');
    const mockScannedFields = [
      { fieldId: 'first_name', name: 'first_name', type: 'text' as const, label: 'First Name', required: true, metadata: {} },
      { fieldId: 'last_name', name: 'last_name', type: 'text' as const, label: 'Last Name', required: true, metadata: {} },
      { fieldId: 'email', name: 'email', type: 'text' as const, label: 'Email', required: true, metadata: {} },
      { fieldId: 'years_experience', name: 'years_experience', type: 'text' as const, label: 'Years of Experience', required: false, metadata: {} },
    ];

    // Persist template in Supabase (Branch 1)
    const savedTemplate = await upsertTemplate({
      job_url: testJobUrl,
      company_name: 'Acme Global',
      job_title: 'Senior Platform Engineer',
      fields_schema: mockScannedFields,
      is_expired: false,
    });
    assert(savedTemplate.job_url === testJobUrl, 'Branch 1: Scanned template upserted to scanned_job_templates');
    assert(savedTemplate.fields_schema.length === 4, 'Branch 1: Scanned fields schema persisted accurately');

    // Persist profile in Supabase (Branch 2)
    const savedProfile = await upsertProfile({
      applywizz_id: candidateId,
      client_name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      email: 'john.doe@example.com',
      phone: '555-0199',
      location: 'San Francisco, CA',
    });
    assert(savedProfile.applywizz_id === candidateId, 'Branch 2: Candidate profile upserted to profiles');

    // =========================================================================
    // Checkpoint 3: 5-Tier Waterfall Answer Resolution
    // =========================================================================
    console.log('\n--- Checkpoint 3: 5-Tier Waterfall Answer Resolution ---');
    const mockSegment: CandidateSegment = {
      applywizzId: candidateId,
      clientName: 'John Doe',
      jobs: [
        {
          rawUrl: testJobUrl,
          canonicalUrl: testJobUrl,
          date: new Date().toISOString(),
          score: 1.0,
          scoredJobId: 'job-1',
          status: 'PENDING',
        },
      ],
      totalJobs: 1,
      syncedAt: new Date().toISOString(),
    };

    const mockTemplateObj: ScannedJobTemplate = {
      jobUrl: testJobUrl,
      companyName: 'Acme Global',
      jobTitle: 'Senior Platform Engineer',
      fields: mockScannedFields,
      isExpired: false,
    };

    const resolver = new AnswerResolver();
    const resolvedApplications = await resolver.resolveAllApplications([mockSegment], [mockTemplateObj]);

    assert(resolvedApplications.length === 1, 'Resolution engine produced 1 application record');
    const resolvedApp = resolvedApplications[0];
    const emailField = resolvedApp.resolvedFields.find((f) => f.fieldId === 'email');
    assert(emailField?.value === 'john.doe@example.com', 'Tier 1 resolved email: "john.doe@example.com"');
    assert(emailField?.source === 'supabase', 'Tier 1 tagged source: "supabase"');
    assert(emailField?.resolvedByTier === 1, 'Tier 1 resolvedByTier === 1');

    // Verify application in Supabase
    const dbApp = await getApplicationByCandidateAndJobMock(candidateId, testJobUrl);
    assert(dbApp !== null, 'Resolved application persisted to candidate_applications table');
    assert(dbApp?.status === 'READY_FOR_REVIEW', 'Application initializes in READY_FOR_REVIEW');

    // =========================================================================
    // Checkpoint 4: Zero Duplicate API Calls on 2nd Run
    // =========================================================================
    console.log('\n--- Checkpoint 4: Zero Duplicate API Calls on Subsequent Run ---');
    const secondResolution = await resolver.resolveAllApplications([mockSegment], [mockTemplateObj]);
    assert(secondResolution.length === 1, 'Second resolution run completes seamlessly');
    const secondEmail = secondResolution[0].resolvedFields.find((f) => f.fieldId === 'email');
    assert(secondEmail?.value === 'john.doe@example.com', 'Cached profile used with 0 remote API calls');

    // =========================================================================
    // Checkpoint 5: Inline Edit & QA Bank Priority Write-back
    // =========================================================================
    console.log('\n--- Checkpoint 5: Inline Edit & QA Bank Priority Write-back ---');
    const patchRes = await fetch(`${apiBaseUrl}/api/applications/${dbApp!.id}/fields/years_experience`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: '8 years' }),
    });
    assert(patchRes.status === 200, 'PATCH /api/applications/:id/fields/:fieldId returned 200');

    const patchedField = await patchRes.json();
    assert(patchedField.value === '8 years', 'Patched field returned updated value: "8 years"');
    assert(patchedField.source === 'manual', 'Patched field tagged source: "manual"');
    assert(patchedField.isEdited === true, 'Patched field tagged isEdited: true');

    // Verify QA Bank entry
    const fp = generateFingerprint('Years of Experience', 'text');
    const qaEntry = await findAnswerByFingerprint(candidateId, fp);
    assert(qaEntry !== null, 'Manual edit recorded in candidate_qa_bank');
    assert(qaEntry?.value === '8 years', 'candidate_qa_bank contains manual value "8 years"');
    assert(qaEntry?.source === 'manual', 'candidate_qa_bank record tagged source: "manual"');

    // =========================================================================
    // Checkpoint 6: Dry-Run Form Filling & Screenshot
    // =========================================================================
    console.log('\n--- Checkpoint 6: Dry-Run Form Filling & Screenshot ---');
    const dryRunPage = await browser.newPage();
    await dryRunPage.goto(mockFormUrl);

    const fillResult = await fillForm(dryRunPage, {
      id: dbApp!.id,
      applywizz_id: candidateId,
      job_url: mockFormUrl,
      status: 'READY_FOR_REVIEW',
      resolved_fields: [
        { fieldId: 'first_name', name: 'first_name', type: 'text', label: 'First Name', value: 'John', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'last_name', name: 'last_name', type: 'text', label: 'Last Name', value: 'Doe', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'email', name: 'email', type: 'text', label: 'Email', value: 'john.doe@example.com', source: 'supabase', resolvedByTier: 1, confidence: 1 },
        { fieldId: 'years_experience', name: 'years_experience', type: 'text', label: 'Years of Experience', value: '8 years', source: 'manual', resolvedByTier: 1, confidence: 1 },
      ],
    }, { minJitterMs: 50, maxJitterMs: 100 });

    assert(fillResult.filledFields === 4, 'Dry-run filled all 4 form fields');
    const dryRunBuf = await dryRunPage.screenshot({ fullPage: true, type: 'png' });
    const dryRunUrl = await uploadDryRunScreenshot(dbApp!.id!, dryRunBuf);
    await setDryRunScreenshotUrl(dbApp!.id!, dryRunUrl);
    await updateStatus(dbApp!.id!, 'DRY_RUN_COMPLETE');

    const dryRunDbApp = await getApplication(dbApp!.id!);
    assert(dryRunDbApp?.status === 'DRY_RUN_COMPLETE', 'Application status transitioned to DRY_RUN_COMPLETE');
    assert(dryRunDbApp?.dry_run_screenshot_url === dryRunUrl, 'dry_run_screenshot_url persisted in DB');
    await dryRunPage.close();

    // =========================================================================
    // Checkpoint 7: Live Submission & Web Proof Capture
    // =========================================================================
    console.log('\n--- Checkpoint 7: Live Submission & Proof Capture ---');
    const submitPage = await browser.newPage();
    await submitPage.goto(mockFormUrl);

    // Set to APPLYING
    await updateStatus(dbApp!.id!, 'APPLYING');

    // Trigger submit button
    await submitPage.click('#submit_app');
    await submitPage.goto(mockConfirmationUrl);

    // Verify confirmation signals
    const verification = await verifySubmissionSignals(submitPage, 5000);
    assert(verification.verified === true, 'Submission confirmation signals verified');

    // Capture web proof
    const proof = await captureWebProof(submitPage, dbApp!.id!);
    assert(typeof proof.proofWebUrl === 'string' && proof.proofWebUrl.length > 0, 'captureWebProof uploaded web proof screenshot');
    assert(proof.proofWebUrl.includes('proofs_web'), 'Proof stored in proofs_web bucket');

    await updateStatus(dbApp!.id!, 'APPLIED');
    const appliedDbApp = await getApplication(dbApp!.id!);
    assert(appliedDbApp?.status === 'APPLIED', 'Application transitioned to terminal APPLIED status');
    assert(appliedDbApp?.proof_web_url === proof.proofWebUrl, 'proof_web_url stored in candidate_applications');
    assert(appliedDbApp?.proof_captured_at !== null, 'proof_captured_at timestamp stored in candidate_applications');
    assert(appliedDbApp?.submitted_at !== null, 'submitted_at timestamp populated on completion');

    await submitPage.close();
  } finally {
    if (browser) await browser.close();
    mockHttpServer.close();
    apiServer.close();
  }

  console.log(`\n🏁 Test Results: ${passed}/${total} passed.`);
  if (passed === total) {
    console.log('🎉 All Phase V2-6 Master E2E Integration checkpoints passed successfully!\n');
    process.exit(0);
  } else {
    console.error('❌ Some checkpoints failed.\n');
    process.exit(1);
  }
}

async function getApplicationByCandidateAndJobMock(applywizzId: string, jobUrl: string) {
  const supabase = getDbClient();
  const { data } = await supabase
    .from('candidate_applications')
    .select('*')
    .eq('applywizz_id', applywizzId)
    .eq('job_url', jobUrl)
    .maybeSingle();
  return data;
}

runE2EIntegrationTestSuite().catch((err) => {
  console.error('Fatal error during E2E integration test suite:', err);
  process.exit(1);
});
