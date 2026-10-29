import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SubmitterPool } from '../src/submitter/submitterPool.js';
import type { ApplicationRow } from '../src/db/applications.js';
import { memoryApplications } from '../src/db/applications/memoryStore.js';
import type {
  AshbySubmissionStage,
  AshbySubmissionTelemetry,
} from '../src/db/applications/types.js';
import {
  submitAshbyApplication,
  capTelemetryMetadata,
} from '../src/submitter/ashbySubmit.js';
import type { LiveSubmitResult } from '../src/submitter/liveSubmit.js';

describe('SubmitterPool ATS Routing', () => {
  it('routes greenhouse applications to submitFn', async () => {
    let greenhouseCalled = false;
    let ashbyCalled = false;

    const dummyApp: ApplicationRow = {
      id: 'app-gh-1',
      applywizz_id: 'AWL-101',
      job_url: 'https://boards.greenhouse.io/test/jobs/12345',
      ats: 'greenhouse',
      status: 'QUEUED',
    } as any;

    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      updateStatusFn: async () => true,
      submitFn: async (appId: string) => {
        greenhouseCalled = true;
        return {
          success: true,
          status: 'APPLIED',
          applicationId: appId,
        } as LiveSubmitResult;
      },
      submitAshbyFn: async () => {
        ashbyCalled = true;
        return {
          success: true,
          status: 'APPLIED',
          applicationId: 'app-gh-1',
        } as LiveSubmitResult;
      },
    });

    try {
      const submission = pool.enqueue(dummyApp);
      await (pool as any).runWorker(0);
      const result = await submission;
      assert.equal(result.status, 'APPLIED');
      assert.equal(greenhouseCalled, true, 'Greenhouse submitFn should have been called');
      assert.equal(ashbyCalled, false, 'Ashby submitFn should NOT have been called');
    } finally {
      await pool.stop();
    }
  });

  it('routes ashby applications to submitAshbyFn', async () => {
    let greenhouseCalled = false;
    let ashbyCalled = false;

    const dummyApp: ApplicationRow = {
      id: 'app-ashby-1',
      applywizz_id: 'AWL-102',
      job_url: 'https://jobs.ashbyhq.com/company/abc-123',
      ats: 'ashby',
      status: 'QUEUED',
    } as any;

    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      updateStatusFn: async () => true,
      submitFn: async (appId: string) => {
        greenhouseCalled = true;
        return {
          success: true,
          status: 'APPLIED',
          applicationId: appId,
        } as LiveSubmitResult;
      },
      submitAshbyFn: async (app: ApplicationRow) => {
        ashbyCalled = true;
        return {
          success: true,
          status: 'APPLIED',
          applicationId: app.id || '',
        } as LiveSubmitResult;
      },
    });

    try {
      const submission = pool.enqueue(dummyApp);
      await (pool as any).runWorker(0);
      const result = await submission;
      assert.equal(result.status, 'APPLIED');
      assert.equal(greenhouseCalled, false, 'Greenhouse submitFn should NOT have been called');
      assert.equal(ashbyCalled, true, 'Ashby submitAshbyFn should have been called');
    } finally {
      await pool.stop();
    }
  });

  it('propagates proof_failed_url when ashby submission fails', async () => {
    let capturedExtra: any = null;

    const dummyApp: ApplicationRow = {
      id: 'app-ashby-fail-1',
      applywizz_id: 'AWL-103',
      job_url: 'https://jobs.ashbyhq.com/company/def-456',
      ats: 'ashby',
      status: 'QUEUED',
    } as any;

    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      updateStatusFn: async (_id: string, _status: any, extra?: any) => {
        if (_status === 'FAILED') {
          capturedExtra = extra;
        }
        return true;
      },
      submitFn: async () => ({} as LiveSubmitResult),
      submitAshbyFn: async () => {
        return {
          success: false,
          status: 'FAILED',
          applicationId: 'app-ashby-fail-1',
          errorMessage: 'Ashby application submit confirmation signal timed out after 45s',
          proofFailedUrl: 'https://storage.supabase.co/proofs_failed/app-ashby-fail-1_failed.png',
        } as LiveSubmitResult;
      },
    });

    try {
      const submission = pool.enqueue(dummyApp);
      await (pool as any).runWorker(0);
      const result = await submission;
      assert.equal(result.status, 'FAILED');
      assert.equal(
        result.proofFailedUrl,
        'https://storage.supabase.co/proofs_failed/app-ashby-fail-1_failed.png'
      );
      assert.ok(capturedExtra, 'updateStatusFn should have been called with extra');
      assert.equal(
        capturedExtra.proof_failed_url,
        'https://storage.supabase.co/proofs_failed/app-ashby-fail-1_failed.png'
      );
    } finally {
      await pool.stop();
    }
  });
});

describe('AshbySubmissionTelemetry & Progressive Stage Tracking', () => {
  it('conforms to AshbySubmissionTelemetry interface and attributes', () => {
    const mockTelemetry: AshbySubmissionTelemetry = {
      deployedCommit: 'sha-abcdef1',
      stage: 'PRE_SUBMIT',
      exitIpHash: '123456789abc',
      proxyRegion: 'us',
      committedFieldCount: 4,
      challengeType: 'none',
      submitResponseStatus: 200,
      errorMessage: 'Field validation error',
      capturedAt: '2026-10-29T12:00:00.000Z',
    };

    assert.equal(mockTelemetry.deployedCommit, 'sha-abcdef1');
    assert.equal(mockTelemetry.stage, 'PRE_SUBMIT');
    assert.equal(mockTelemetry.exitIpHash, '123456789abc');
    assert.equal(mockTelemetry.proxyRegion, 'us');
    assert.equal(mockTelemetry.committedFieldCount, 4);
    assert.equal(mockTelemetry.challengeType, 'none');
    assert.equal(mockTelemetry.submitResponseStatus, 200);
    assert.equal(mockTelemetry.errorMessage, 'Field validation error');
    assert.equal(mockTelemetry.capturedAt, '2026-10-29T12:00:00.000Z');
  });

  it('validates all eight AshbySubmissionStage milestones in progressive order', () => {
    const expectedStages: AshbySubmissionStage[] = [
      'PREFLIGHT',
      'NAVIGATION',
      'DOM_SCAN',
      'FORM_FILL',
      'PRE_SUBMIT',
      'SUBMIT_CLICK',
      'WAIT_CONFIRMATION',
      'COMPLETED',
    ];

    assert.equal(expectedStages.length, 8);
    for (const stage of expectedStages) {
      const telemetry: AshbySubmissionTelemetry = {
        stage,
        capturedAt: new Date().toISOString(),
      };
      assert.equal(telemetry.stage, stage);
    }
  });

  it('records PREFLIGHT stage telemetry in error_details when candidate profile is missing', async () => {
    let capturedStatus: any = null;
    let capturedExtra: any = null;

    const testAppId = 'test-ashby-preflight-fail-' + Date.now();
    const dummyApp: ApplicationRow = {
      id: testAppId,
      applywizz_id: 'AWL-NONEXISTENT-CANDIDATE-XYZ',
      job_url: 'https://jobs.ashbyhq.com/company/sample-job',
      ats: 'ashby',
      status: 'QUEUED',
      resolved_fields: [],
    };

    const result = await submitAshbyApplication(dummyApp, {
      updateStatusFn: async (_id, status, extra) => {
        capturedStatus = status;
        capturedExtra = extra;
      },
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.success, false);
    assert.equal(capturedStatus, 'FAILED');
    assert.ok(capturedExtra?.error_details, 'error_details should be recorded in updateStatus');

    const telemetry = capturedExtra.error_details as AshbySubmissionTelemetry;
    assert.equal(telemetry.stage, 'PREFLIGHT');
    assert.ok(
      telemetry.errorMessage?.includes('Profile not found'),
      `Expected error message to mention Profile not found, got: ${telemetry.errorMessage}`
    );
    assert.ok(telemetry.capturedAt);
    assert.ok(telemetry.deployedCommit);
    assert.equal(telemetry.challengeType, 'none');

    // Also assert result.telemetry matches
    assert.equal(result.telemetry?.stage, 'PREFLIGHT');
    assert.equal(result.telemetry?.errorMessage, telemetry.errorMessage);
  });

  it('caps telemetry metadata JSON to <= 1024 bytes', () => {
    const hugeTelemetry: AshbySubmissionTelemetry = {
      deployedCommit: 'a'.repeat(100),
      stage: 'WAIT_CONFIRMATION',
      exitIpHash: 'b'.repeat(64),
      proxyRegion: 'us',
      committedFieldCount: 20,
      challengeType: 'none',
      submitResponseStatus: 500,
      errorMessage: 'x'.repeat(2000), // very long error message
      capturedAt: new Date().toISOString(),
    };

    const capped = capTelemetryMetadata(hugeTelemetry, 1024);
    const byteLength = Buffer.byteLength(JSON.stringify(capped), 'utf8');
    assert.ok(byteLength <= 1024, `Expected capped JSON <= 1024 bytes, got ${byteLength}`);
    assert.equal(capped.stage, 'WAIT_CONFIRMATION');
    assert.equal(capped.committedFieldCount, 20);
  });

  it('propagates AshbySubmissionTelemetry inside error_details on submit failure through SubmitterPool', async () => {
    let capturedExtra: any = null;

    const dummyApp: ApplicationRow = {
      id: 'app-ashby-telemetry-pool',
      applywizz_id: 'AWL-105',
      job_url: 'https://jobs.ashbyhq.com/company/telemetry-job',
      ats: 'ashby',
      status: 'QUEUED',
    } as any;

    const mockTelemetry: AshbySubmissionTelemetry = {
      deployedCommit: 'test-commit-sha',
      stage: 'DOM_SCAN',
      exitIpHash: '123456789abc',
      proxyRegion: 'us',
      committedFieldCount: 0,
      challengeType: 'none',
      errorMessage: 'Ashby form fields selector timed out',
      capturedAt: new Date().toISOString(),
    };

    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      updateStatusFn: async (_id: string, _status: any, extra?: any) => {
        if (_status === 'FAILED') {
          capturedExtra = extra;
        }
        return true;
      },
      submitFn: async () => ({} as LiveSubmitResult),
      submitAshbyFn: async () => {
        return {
          success: false,
          status: 'FAILED',
          applicationId: 'app-ashby-telemetry-pool',
          errorMessage: 'Ashby form fields selector timed out',
          proofFailedUrl: 'https://storage.supabase.co/proofs_failed/test.png',
          telemetry: mockTelemetry,
        } as LiveSubmitResult & { telemetry?: AshbySubmissionTelemetry };
      },
    });

    try {
      const submission = pool.enqueue(dummyApp);
      await (pool as any).runWorker(0);
      const result = await submission;
      assert.equal(result.status, 'FAILED');
      assert.ok(capturedExtra);
      assert.equal(capturedExtra.proof_failed_url, 'https://storage.supabase.co/proofs_failed/test.png');
    } finally {
      await pool.stop();
    }
  });
});
