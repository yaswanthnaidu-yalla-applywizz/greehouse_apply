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
});
