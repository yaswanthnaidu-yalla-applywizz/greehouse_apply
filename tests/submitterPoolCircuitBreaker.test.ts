import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SubmitterPool } from '../src/submitter/submitterPool.js';
import type { ApplicationRow } from '../src/db/applications.js';

process.env.FORCE_MEMORY_DB = 'true';
process.env.SANDBOX = 'true';

describe('SubmitterPool Launch Failure Circuit Breaker', () => {
  it('engages circuit breaker on BROWSER_LAUNCH_FAILED and pauses dispatchOnce', async () => {
    let dequeueCalls = 0;
    const testApp: ApplicationRow = {
      id: 'cb-app-1',
      applywizz_id: 'AWL-CB-1',
      job_url: 'https://boards.greenhouse.io/test/jobs/1',
      status: 'QUEUED',
      resolved_fields: [],
    };

    const pool = new SubmitterPool({
      poolSize: 1,
      launchFailureCooldownMs: 2000,
      dequeueFn: async () => {
        dequeueCalls++;
        return testApp;
      },
      submitFn: async () => ({
        success: false,
        status: 'FAILED',
        applicationId: 'cb-app-1',
        errorMessage: 'Error: spawn /chrome-headless-shell EAGAIN',
        retryReason: 'BROWSER_LAUNCH_FAILED',
      }),
      requeueFn: async () => ({ requeued: true, retryCount: 1 }),
      updateStatusFn: async () => true,
    });

    try {
      // 1. Enqueue and process one failing submission in lane 0
      const submissionPromise = pool.enqueue(testApp);
      await (pool as any).runWorker(0);
      await submissionPromise;

      const cooldownUntil = (pool as any).launchFailureCooldownUntil;
      assert.ok(cooldownUntil > Date.now(), 'cooldown must be set in the future');

      // 2. dispatchOnce within cooldown must skip dequeueing
      const resultBefore = await pool.dispatchOnce();
      assert.equal(dequeueCalls, 0, 'dequeueFn must NOT be called while circuit breaker is active');
      assert.equal(resultBefore.dequeued, 0);

      // 3. Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 2100));

      // 4. dispatchOnce after cooldown must resume dequeueing
      const resultAfter = await pool.dispatchOnce();
      assert.equal(dequeueCalls, 1, 'dequeueFn should be called after cooldown expires');
      assert.equal(resultAfter.dequeued, 1);
    } finally {
      await pool.stop();
    }
  });
});
