import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApplicationRow } from '../src/db/applications.js';
import type { AutomaticSubmissionRetryReason } from '../src/submitter/submissionRetry.js';
import { SubmitterPool } from '../src/submitter/submitterPool.js';
import type { LiveSubmitOptions, LiveSubmitResult } from '../src/submitter/liveSubmit.js';

process.env.FORCE_MEMORY_DB = 'true';

type SubmitFn = (
  applicationId: string,
  options: LiveSubmitOptions
) => Promise<LiveSubmitResult>;
type RequeueFn = (
  applicationId: string,
  reason: string,
  retryReason: AutomaticSubmissionRetryReason,
  jobUrl?: string
) => Promise<{ requeued: boolean; retryCount: number }>;

const application: ApplicationRow = {
  id: 'retry-test-app',
  applywizz_id: 'AWL-RETRY-TEST',
  job_url: 'https://boards.greenhouse.io/example/jobs/123',
  status: 'QUEUED',
  resolved_fields: [],
};

function makePool(submitFn: SubmitFn, requeueFn: RequeueFn, statuses: Array<{ status: string; extra?: unknown }>) {
  const options = {
    updateStatusFn: async (_id: string, status: string, extra?: unknown) => {
      statuses.push({ status, extra });
      return true;
    },
    submitFn,
    requeueFn,
  };
  return new SubmitterPool(options);
}

const seamProbeSubmit: SubmitFn = async () => ({
  success: false,
  status: 'FAILED',
  applicationId: application.id!,
});
const seamProbeRequeue: RequeueFn = async () => ({ requeued: false, retryCount: 0 });
const seamProbePool = makePool(seamProbeSubmit, seamProbeRequeue, []);
const hasRetrySeams =
  Reflect.get(seamProbePool, 'submitFn') === seamProbeSubmit &&
  Reflect.get(seamProbePool, 'requeueFn') === seamProbeRequeue;

async function processSubmission(
  submitFn: SubmitFn,
  requeueFn: RequeueFn
): Promise<{
  statuses: Array<{ status: string; extra?: unknown }>;
  requeueCalls: Array<[string, string, AutomaticSubmissionRetryReason, string?]>;
  submission: Promise<LiveSubmitResult>;
}> {
  const statuses: Array<{ status: string; extra?: unknown }> = [];
  const requeueCalls: Array<[string, string, AutomaticSubmissionRetryReason, string?]> = [];
  const pool = makePool(
    submitFn,
    async (...args) => {
      requeueCalls.push(args);
      return requeueFn(...args);
    },
    statuses
  );
  const submission = pool.enqueue(application);
  const runWorker = Reflect.get(pool, 'runWorker');
  assert.equal(typeof runWorker, 'function');
  await runWorker.call(pool, 0);
  return { statuses, requeueCalls, submission };
}

it('accepts injected submitter and requeue operations for isolated queue tests', () => {
  assert.equal(hasRetrySeams, true);
});

describe('SubmitterPool automatic retry policy', { skip: !hasRetrySeams }, () => {
  it('keeps required-field failures failed without requeueing', async () => {
    const { statuses, requeueCalls } = await processSubmission(
      async () => ({
        success: false,
        status: 'FAILED',
        applicationId: application.id!,
        errorMessage: 'Required field is unresolved.',
        retryReason: 'UNRESOLVED_REQUIRED_FIELD',
      }),
      async () => ({ requeued: true, retryCount: 1 })
    );

    assert.equal(requeueCalls.length, 0);
    assert.deepEqual(statuses.at(-1), {
      status: 'FAILED',
      extra: {
        error_message: 'Required field is unresolved.',
        job_url: application.job_url,
      },
    });
  });

  it('does not requeue a failed result without an explicit retry reason', async () => {
    const { statuses, requeueCalls } = await processSubmission(
      async () => ({
        success: false,
        status: 'FAILED',
        applicationId: application.id!,
        errorMessage: 'Submission failed.',
      }),
      async () => ({ requeued: true, retryCount: 1 })
    );

    assert.equal(requeueCalls.length, 0);
    assert.equal(statuses.at(-1)?.status, 'FAILED');
  });

  it('attempts one explicitly eligible retry and respects a terminal retry outcome', async () => {
    const { statuses, requeueCalls } = await processSubmission(
      async () => ({
        success: false,
        status: 'FAILED',
        applicationId: application.id!,
        errorMessage: 'Browser launch failed.',
        retryReason: 'BROWSER_LAUNCH_FAILED',
      }),
      async () => ({ requeued: false, retryCount: 3 })
    );

    assert.deepEqual(requeueCalls, [[
      application.id!,
      'Browser launch failed.',
      'BROWSER_LAUNCH_FAILED',
      application.job_url,
    ]]);
    assert.deepEqual(statuses.map(({ status }) => status), ['APPLYING']);
  });

  it('marks exceptions with unrecognized messages failed without requeueing', async () => {
    const { statuses, requeueCalls, submission } = await processSubmission(
      async () => {
        throw new Error('Target crashed');
      },
      async () => ({ requeued: true, retryCount: 1 })
    );

    await assert.rejects(submission, /Target crashed/);
    assert.equal(requeueCalls.length, 0);
    assert.deepEqual(statuses.at(-1), {
      status: 'FAILED',
      extra: {
        error_message: 'Target crashed',
        job_url: application.job_url,
      },
    });
  });
});
