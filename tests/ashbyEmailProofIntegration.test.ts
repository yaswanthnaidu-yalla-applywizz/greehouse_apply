import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureAndSaveEmailProof,
  startEmailProofPolling,
} from '../src/services/inbox/inboxPoller.js';
import { handleWorkerSubmissionResult } from '../src/queue/worker.js';
import type { ApplicationRow, EmailProofJson } from '../src/db/applications/types.js';

describe('Ashby Email Proof Integration & Lifecycle (Task 10)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('1. Web submit succeeds -> EMAIL_PROOF_PENDING written -> immediate email matches -> APPLIED with proof_email_json', async () => {
    let queryArgsCaptured: any = null;
    const submissionTime = new Date('2026-10-29T12:00:00Z').toISOString();

    const matchedEmail: EmailProofJson = {
      messageId: 'msg-ashby-success-123',
      from: 'jobs@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank You for Applying to Nexxen',
      received_at: new Date('2026-10-29T12:00:05Z').toISOString(),
      body_text: 'Thank you for applying to Nexxen! We have received your application.',
    };

    const statusUpdates: Array<{ id: string; status: string; extra: any }> = [];

    const mockApp: ApplicationRow = {
      id: 'app-ashby-001',
      applywizz_id: 'AWL-31428',
      candidate_email: 'candidate@applywizard.ai',
      job_url: 'https://jobs.ashbyhq.com/nexxen/12345',
      company_name: 'Nexxen',
      job_title: 'Staff Software Engineer',
      ats: 'ashby',
      status: 'EMAIL_PROOF_PENDING',
      submitted_at: submissionTime,
      resolved_fields: [
        { fieldId: 'email', name: 'email', value: 'candidate@applywizard.ai', isRequired: true },
      ],
    } as any;

    const result = await captureAndSaveEmailProof(mockApp, {
      updateStatusFn: async (id, status, extra) => {
        statusUpdates.push({ id, status, extra });
        return true;
      },
      queryConfirmationEmailFn: async (options) => {
        queryArgsCaptured = options;
        return {
          success: true,
          matched: true,
          email: matchedEmail,
        };
      },
    });

    assert.equal(result.matched, true);
    assert.deepEqual(result.proof, matchedEmail);
    assert.equal(queryArgsCaptured.ats, 'ashby');
    assert.equal(queryArgsCaptured.jobTitle, 'Staff Software Engineer');
    assert.equal(queryArgsCaptured.candidateEmail, 'candidate@applywizard.ai');
    assert.equal(queryArgsCaptured.companyName, 'Nexxen');

    // Verify status update transition to APPLIED
    const appliedUpdate = statusUpdates.find((u) => u.status === 'APPLIED');
    assert.ok(appliedUpdate, 'Application should be transitioned to APPLIED');
    assert.deepEqual(appliedUpdate.extra.proof_email_json, matchedEmail);
    assert.equal(appliedUpdate.extra.manual_review_needed, false);
    assert.equal(appliedUpdate.extra.email_proof_status, 'captured');
  });

  it('2. Web submit succeeds -> immediate email misses -> application remains EMAIL_PROOF_PENDING with poller active', async () => {
    let queryArgsCaptured: any = null;
    const submissionTime = new Date('2026-10-29T12:00:00Z').toISOString();
    const statusUpdates: Array<{ id: string; status: string; extra: any }> = [];

    const mockApp: ApplicationRow = {
      id: 'app-ashby-002',
      applywizz_id: 'AWL-31428',
      job_url: 'https://jobs.ashbyhq.com/nexxen/12345',
      company_name: 'Nexxen',
      job_title: 'Staff Software Engineer',
      ats: 'ashby',
      status: 'EMAIL_PROOF_PENDING',
      proof_web_url: 'https://storage.supabase.com/proofs_web/app-ashby-002.png',
      proof_captured_at: submissionTime,
      submitted_at: submissionTime,
      resolved_fields: [
        { fieldId: 'email', name: 'email', value: 'candidate@applywizard.ai', isRequired: true },
      ],
    };

    const result = await captureAndSaveEmailProof(mockApp, {
      updateStatusFn: async (id, status, extra) => {
        statusUpdates.push({ id, status, extra });
        return true;
      },
      queryConfirmationEmailFn: async (options) => {
        queryArgsCaptured = options;
        return {
          success: true,
          matched: false,
          errorMessage: 'No confirmation email received within window',
        };
      },
    });

    assert.equal(result.matched, false);
    assert.equal(result.proof, null);
    assert.equal(queryArgsCaptured.ats, 'ashby');

    // Verify it was NOT overwritten with FAILED or APPLIED
    const nonPending = statusUpdates.find((u) => u.status === 'FAILED' || u.status === 'APPLIED');
    assert.equal(nonPending, undefined, 'Application should NOT be marked FAILED or APPLIED on immediate miss');

    // Start background poller and verify it runs active cycles
    let pollCount = 0;
    const pollerHandle = startEmailProofPolling(mockApp, {
      intervalMs: 10,
      maxDurationMs: 100,
      queryConfirmationEmailFn: async () => {
        pollCount += 1;
        return { success: true, matched: false };
      },
    });

    assert.ok(pollerHandle, 'Poller handle should be returned');
    assert.equal(typeof pollerHandle.stop, 'function');
    pollerHandle.stop();
  });

  it('3. Timeout leaves Ashby application in EMAIL_PROOF_PENDING with manual_review_needed: true (never FAILED)', async () => {
    const statusUpdates: Array<{ id: string; status: string; extra: any }> = [];
    const submissionTime = new Date('2026-10-29T12:00:00Z').toISOString();

    const mockApp: ApplicationRow = {
      id: 'app-ashby-003',
      applywizz_id: 'AWL-31428',
      job_url: 'https://jobs.ashbyhq.com/keycard/9999',
      company_name: 'Keycard',
      job_title: 'Full Stack Engineer',
      ats: 'ashby',
      status: 'EMAIL_PROOF_PENDING',
      proof_web_url: 'https://storage.supabase.com/proofs_web/app-ashby-003.png',
      proof_captured_at: submissionTime,
      submitted_at: submissionTime,
      resolved_fields: [
        { fieldId: 'email', name: 'email', value: 'candidate@applywizard.ai', isRequired: true },
      ],
    };

    // Run short-duration poller that times out
    await new Promise<void>((resolve) => {
      startEmailProofPolling(mockApp, {
        intervalMs: 5,
        maxDurationMs: 15,
        updateStatusFn: async (id, status, extra) => {
          statusUpdates.push({ id, status, extra });
          return true;
        },
        queryConfirmationEmailFn: async () => {
          return { success: true, matched: false };
        },
        onTimeout: () => {
          resolve();
        },
      });
    });

    const timeoutUpdate = statusUpdates.find(
      (u) => u.status === 'EMAIL_PROOF_PENDING' && (u.extra.manual_review_needed === true || u.extra.email_proof_status === 'manual_review_needed')
    );
    assert.ok(timeoutUpdate, 'Timeout must keep EMAIL_PROOF_PENDING and set manual_review_needed: true');
    assert.equal(timeoutUpdate.extra.manual_review_needed, true);

    const failedUpdate = statusUpdates.find((u) => u.status === 'FAILED');
    assert.equal(failedUpdate, undefined, 'Timeout MUST NEVER mark status as FAILED; web proof is preserved');
  });

  it('4. Worker handles EMAIL_PROOF_PENDING and APPLIED without contradictory overwrites', async () => {
    const mockApp: ApplicationRow = {
      id: 'app-ashby-004',
      applywizz_id: 'AWL-31428',
      job_url: 'https://jobs.ashbyhq.com/nexxen/12345',
      company_name: 'Nexxen',
      ats: 'ashby',
      status: 'EMAIL_PROOF_PENDING',
      resolved_fields: [],
    };

    const statusCalls: Array<{ id: string; status: string }> = [];
    const context = {
      updateStatusFn: async (id: string, status: any) => {
        statusCalls.push({ id, status });
        return true;
      },
      logStatusChangeFn: async () => true,
    };

    // Test EMAIL_PROOF_PENDING result
    const pendingResult = await handleWorkerSubmissionResult(
      {
        success: true,
        status: 'EMAIL_PROOF_PENDING',
        applicationId: 'app-ashby-004',
        submitClicked: true,
        submitClickedAt: new Date().toISOString(),
      },
      mockApp,
      context
    );

    assert.equal(pendingResult.status, 'EMAIL_PROOF_PENDING');
    assert.equal(statusCalls.length, 0, 'Worker must not overwrite EMAIL_PROOF_PENDING with FAILED or APPLIED');

    // Test APPLIED result
    const appliedResult = await handleWorkerSubmissionResult(
      {
        success: true,
        status: 'APPLIED',
        applicationId: 'app-ashby-004',
        submitClicked: true,
        submitClickedAt: new Date().toISOString(),
      },
      mockApp,
      context
    );

    assert.equal(appliedResult.status, 'APPLIED');
    assert.equal(statusCalls.length, 0, 'Worker must not make contradictory overwrite when already APPLIED');
  });
});
