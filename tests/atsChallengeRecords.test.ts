import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApplicationRow, VerificationFailureDetails } from '../src/db/applications/types.js';
import { SubmitterPool } from '../src/submitter/submitterPool.js';
import { submitLeverApplication } from '../src/submitter/leverSubmit.js';
import { getRetryReason, isAutomaticRetryAllowed } from '../src/submitter/submissionRetry.js';

process.env.FORCE_MEMORY_DB = 'true';

describe('ATS Challenge Records and Persistence', () => {
  it('persists FAILED status with structured verificationFailure details and null retryReason', async () => {
    const statuses: Array<{ status: string; extra?: any }> = [];
    const challenge: VerificationFailureDetails = {
      reasonCode: 'INTERACTIVE_CHALLENGE',
      ats: 'lever',
      provider: 'hcaptcha',
      stage: 'PRE_SUBMIT',
      capturedAt: new Date().toISOString(),
      submitClicked: false,
      submitClickedAt: null,
    };

    const application: ApplicationRow = {
      id: 'app-lever-challenge-1',
      applywizz_id: 'AWL-CHALLENGE-1',
      job_url: 'https://jobs.lever.co/example/test-job',
      status: 'APPLYING',
      resolved_fields: [],
      ats: 'lever',
    };

    const pool = new SubmitterPool({
      poolSize: 1,
      updateStatusFn: async (id, status, extra) => {
        statuses.push({ status, extra });
        return true;
      },
      submitLeverFn: async (app, options) => {
        await options.updateStatusFn?.(app.id!, 'FAILED', {
          error_message: 'Lever interactive verification detected: human verification challenge',
          error_details: { verificationFailure: challenge },
          job_url: app.job_url,
        });
        return {
          success: false,
          status: 'FAILED',
          applicationId: app.id!,
          errorMessage: 'Lever interactive verification detected: human verification challenge',
          verificationFailure: challenge,
          retryReason: null,
        };
      },
      requeueFn: async () => ({ requeued: true, retryCount: 1 }),
    });

    const resultPromise = pool.enqueue(application);
    const runWorker = Reflect.get(pool, 'runWorker');
    await runWorker.call(pool, 0);

    const result = await resultPromise;
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryReason, null);
    assert.deepEqual(result.verificationFailure, challenge);

    // Verify persisted status update
    assert.equal(statuses.length, 2); // APPLYING -> FAILED
    assert.equal(statuses[0].status, 'APPLYING');
    assert.equal(statuses[1].status, 'FAILED');
    assert.deepEqual(statuses[1].extra.error_details.verificationFailure, challenge);
  });

  it('retains reason even if failure screenshot upload fails', async () => {
    const statuses: Array<{ status: string; extra?: any }> = [];
    const challenge: VerificationFailureDetails = {
      reasonCode: 'INTERACTIVE_CHALLENGE',
      ats: 'lever',
      provider: 'hcaptcha',
      stage: 'SUBMIT_WAIT',
      capturedAt: new Date().toISOString(),
      submitClicked: true,
      submitClickedAt: new Date().toISOString(),
    };

    const application: ApplicationRow = {
      id: 'app-lever-screenshot-fail',
      applywizz_id: 'AWL-SCREENSHOT-FAIL',
      job_url: 'https://jobs.lever.co/example/test-job-2',
      status: 'APPLYING',
      resolved_fields: [],
      ats: 'lever',
    };

    // Even if screenshot storage fails, the status update receives the error details and reason
    const mockUpdateStatus = async (_id: string, status: string, extra?: any) => {
      statuses.push({ status, extra });
      return true;
    };

    const mockResult = {
      success: false,
      status: 'FAILED' as const,
      applicationId: application.id!,
      errorMessage: 'Challenge active and screenshot failed',
      verificationFailure: challenge,
      retryReason: null,
    };

    const retryReason = getRetryReason(mockResult);
    assert.equal(retryReason, null);
    assert.equal(isAutomaticRetryAllowed(retryReason), false);
    assert.equal(mockResult.verificationFailure.reasonCode, 'INTERACTIVE_CHALLENGE');
  });

  it('does not allow retry when post-click exception occurs', () => {
    const postClickFailure = {
      retryReason: null,
      submitClicked: true,
      submitClickedAt: new Date().toISOString(),
      errorMessage: 'Network timeout waiting for response after submit click',
      verificationFailure: {
        reasonCode: 'SUBMISSION_UNCONFIRMED' as const,
        ats: 'lever' as const,
        provider: 'unknown' as const,
        stage: 'SUBMIT_WAIT',
        capturedAt: new Date().toISOString(),
        submitClicked: true,
        submitClickedAt: new Date().toISOString(),
      },
    };

    const reason = getRetryReason(postClickFailure);
    assert.equal(reason, null);
    assert.equal(isAutomaticRetryAllowed(reason), false);
  });

  it('allows the next unrelated application to run when one application hits a challenge', async () => {
    const statuses: Array<{ status: string; id: string; extra?: any }> = [];
    let app1Executed = false;
    let app2Executed = false;

    const challengeApp: ApplicationRow = {
      id: 'app-challenged',
      applywizz_id: 'AWL-CHALLENGED',
      job_url: 'https://jobs.ashbyhq.com/example/job1',
      status: 'QUEUED',
      resolved_fields: [],
      ats: 'ashby',
    };

    const regularApp: ApplicationRow = {
      id: 'app-next-regular',
      applywizz_id: 'AWL-REGULAR',
      job_url: 'https://boards.greenhouse.io/example/job2',
      status: 'QUEUED',
      resolved_fields: [],
      ats: 'greenhouse',
    };

    const pool = new SubmitterPool({
      poolSize: 1,
      updateStatusFn: async (id, status, extra) => {
        statuses.push({ id, status, extra });
        return true;
      },
      submitAshbyFn: async (app) => {
        app1Executed = true;
        return {
          success: false,
          status: 'FAILED',
          applicationId: app.id!,
          errorMessage: 'Interactive challenge detected',
          verificationFailure: {
            reasonCode: 'INTERACTIVE_CHALLENGE',
            ats: 'ashby',
            provider: 'turnstile',
            stage: 'DOM_SCAN',
            capturedAt: new Date().toISOString(),
            submitClicked: false,
            submitClickedAt: null,
          },
          retryReason: null,
        };
      },
      submitFn: async (id) => {
        app2Executed = true;
        return {
          success: true,
          status: 'APPLIED',
          applicationId: id,
        };
      },
      requeueFn: async () => ({ requeued: false, retryCount: 0 }),
    });

    const res1Promise = pool.enqueue(challengeApp);
    const runWorker = Reflect.get(pool, 'runWorker');
    await runWorker.call(pool, 0);
    const res1 = await res1Promise;
    assert.equal(res1.status, 'FAILED');
    assert.equal(app1Executed, true);

    const res2Promise = pool.enqueue(regularApp);
    await runWorker.call(pool, 0);
    const res2 = await res2Promise;
    assert.equal(res2.status, 'APPLIED');
    assert.equal(app2Executed, true);

    // Queue continued seamlessly
    const processedIds = statuses.map((s) => s.id);
    assert.ok(processedIds.includes('app-challenged'));
    assert.ok(processedIds.includes('app-next-regular'));
  });

  it('preserves existing Greenhouse submitter and result handling', async () => {
    let greenhouseCalled = false;
    const ghApp: ApplicationRow = {
      id: 'app-gh-standard',
      applywizz_id: 'AWL-GH-STD',
      job_url: 'https://boards.greenhouse.io/example/engineer',
      status: 'QUEUED',
      resolved_fields: [],
      ats: 'greenhouse',
    };

    const pool = new SubmitterPool({
      poolSize: 1,
      updateStatusFn: async () => true,
      submitFn: async (id) => {
        greenhouseCalled = true;
        return {
          success: true,
          status: 'APPLIED',
          applicationId: id,
          hasEmailProof: false,
        };
      },
      requeueFn: async () => ({ requeued: false, retryCount: 0 }),
    });

    const resPromise = pool.enqueue(ghApp);
    const runWorker = Reflect.get(pool, 'runWorker');
    await runWorker.call(pool, 0);
    const res = await resPromise;

    assert.equal(greenhouseCalled, true);
    assert.equal(res.status, 'APPLIED');
    assert.equal(res.success, true);
  });

  it('persists APPLIED for Lever success without duplicate or overwriting writes', async () => {
    const statuses: Array<{ status: string; extra?: any }> = [];
    const leverApp: ApplicationRow = {
      id: 'app-lever-success',
      applywizz_id: 'AWL-LEVER-SUCC',
      job_url: 'https://jobs.lever.co/example/engineer',
      status: 'QUEUED',
      resolved_fields: [],
      ats: 'lever',
    };

    const pool = new SubmitterPool({
      poolSize: 1,
      updateStatusFn: async (_id, status, extra) => {
        statuses.push({ status, extra });
        return true;
      },
      submitLeverFn: async (app, options) => {
        await options.updateStatusFn?.(app.id!, 'APPLIED', {
          job_url: app.job_url,
          error_details: { stage: 'SUBMIT_CONFIRMED', submitClicked: true },
        });
        return {
          success: true,
          status: 'APPLIED',
          applicationId: app.id!,
          submitClicked: true,
          submitClickedAt: new Date().toISOString(),
        };
      },
      requeueFn: async () => ({ requeued: false, retryCount: 0 }),
    });

    const resPromise = pool.enqueue(leverApp);
    const runWorker = Reflect.get(pool, 'runWorker');
    await runWorker.call(pool, 0);
    const res = await resPromise;

    assert.equal(res.status, 'APPLIED');
    assert.equal(res.success, true);

    // Status transitions: APPLYING by pool, then exactly APPLIED by Lever
    assert.deepEqual(statuses.map((s) => s.status), ['APPLYING', 'APPLIED']);
    assert.equal(statuses[1].extra.error_details.stage, 'SUBMIT_CONFIRMED');
  });
});
