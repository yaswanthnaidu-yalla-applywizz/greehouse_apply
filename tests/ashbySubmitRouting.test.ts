import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SubmitterPool } from '../src/submitter/submitterPool.js';
import type { ApplicationRow } from '../src/db/applications.js';
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
