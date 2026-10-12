import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { SubmitterPool } from '../src/submitter/submitterPool.js';
import type { ApplicationRow } from '../src/db/applications.js';

describe('Phase 1: SubmitterPool Backpressure & Idle Gating', () => {
  beforeEach(() => {
    process.env.SUBMISSION_POOL_SIZE = '3';
    process.env.SANDBOX = 'true';
  });

  it('dispatchQueue does not call DB when idleCount === 0', async () => {
    let dbCallCount = 0;
    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      dequeueFn: async () => {
        dbCallCount++;
        return null;
      },
      updateStatusFn: async () => true,
    });

    try {
      // Simulate all 3 workers being busy by assigning dummy in-flight entries
      const dummyApp1: ApplicationRow = { id: 'app-1', applywizz_id: 'AWL-1', job_url: 'https://gh.io/1', status: 'QUEUED' } as any;
      const dummyApp2: ApplicationRow = { id: 'app-2', applywizz_id: 'AWL-2', job_url: 'https://gh.io/2', status: 'QUEUED' } as any;
      const dummyApp3: ApplicationRow = { id: 'app-3', applywizz_id: 'AWL-3', job_url: 'https://gh.io/3', status: 'QUEUED' } as any;

      void pool.enqueue(dummyApp1);
      void pool.enqueue(dummyApp2);
      void pool.enqueue(dummyApp3);

      assert.equal(pool.getIdleCount(), 0, 'idleCount should be 0 when all 3 workers are assigned');

      const result = await pool.dispatchOnce();
      assert.equal(result.dequeued, 0, 'dequeued count must be 0 when idleCount is 0');
      assert.equal(dbCallCount, 0, 'dequeueFn must NOT be called when idleCount is 0');
    } finally {
      await pool.stop();
    }
  });

  it('dispatchQueue dequeues exactly idleCount=3 when 3 workers idle', async () => {
    let availableQueue = [
      { id: 'app-1', applywizz_id: 'AWL-1', job_url: 'https://gh.io/1', status: 'QUEUED' } as ApplicationRow,
      { id: 'app-2', applywizz_id: 'AWL-2', job_url: 'https://gh.io/2', status: 'QUEUED' } as ApplicationRow,
      { id: 'app-3', applywizz_id: 'AWL-3', job_url: 'https://gh.io/3', status: 'QUEUED' } as ApplicationRow,
      { id: 'app-4', applywizz_id: 'AWL-4', job_url: 'https://gh.io/4', status: 'QUEUED' } as ApplicationRow,
      { id: 'app-5', applywizz_id: 'AWL-5', job_url: 'https://gh.io/5', status: 'QUEUED' } as ApplicationRow,
    ];

    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      dequeueFn: async () => {
        return availableQueue.shift() || null;
      },
      updateStatusFn: async () => true,
    });

    try {
      assert.equal(pool.getIdleCount(), 3, 'initial idle count should be 3');

      const result = await pool.dispatchOnce();
      assert.equal(result.dequeued, 3, 'should dequeue exactly 3 applications when 3 workers are idle');
      assert.equal(result.idleWorkers, 0, 'idle workers should become 0 after dispatching 3');
      assert.equal(result.inFlight, 3, 'inFlight applications should be exactly 3');
      assert.equal(availableQueue.length, 2, '2 applications should remain in DB queue, not drained prematurely');
    } finally {
      await pool.stop();
    }
  });

  it('stop() reverts all inFlightApplicationIds to QUEUED', async () => {
    const revertedIds: string[] = [];
    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      updateStatusFn: async (id: string, status: string) => {
        if (status === 'QUEUED') {
          revertedIds.push(id);
        }
        return true;
      },
    });

    try {
      const dummyApp1: ApplicationRow = { id: 'app-rev-1', applywizz_id: 'AWL-1', job_url: 'https://gh.io/1', status: 'QUEUED' } as any;
      const dummyApp2: ApplicationRow = { id: 'app-rev-2', applywizz_id: 'AWL-2', job_url: 'https://gh.io/2', status: 'QUEUED' } as any;

      void pool.enqueue(dummyApp1);
      void pool.enqueue(dummyApp2);

      const snapBefore = pool.getSnapshot();
      assert.equal(snapBefore.inFlightCount, 2);

      await pool.stop();

      const snapAfter = pool.getSnapshot();
      assert.equal(snapAfter.inFlightCount, 0, 'inFlightCount should be 0 after stop()');
      assert.ok(revertedIds.includes('app-rev-1'), 'app-rev-1 should be reverted to QUEUED');
      assert.ok(revertedIds.includes('app-rev-2'), 'app-rev-2 should be reverted to QUEUED');
    } finally {
      await pool.stop();
    }
  });

  it('SIGINT triggers same revert path as stop()', async () => {
    const revertedIds: string[] = [];
    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      updateStatusFn: async (id: string, status: string) => {
        if (status === 'QUEUED') {
          revertedIds.push(id);
        }
        return true;
      },
    });

    try {
      const dummyApp: ApplicationRow = { id: 'app-sig-1', applywizz_id: 'AWL-SIG', job_url: 'https://gh.io/sig', status: 'QUEUED' } as any;
      void pool.enqueue(dummyApp);

      assert.equal(pool.getSnapshot().inFlightCount, 1);

      await pool.handleShutdownSignal('SIGINT');

      assert.equal(pool.getSnapshot().inFlightCount, 0, 'inFlightCount should be 0 after SIGINT');
      assert.ok(revertedIds.includes('app-sig-1'), 'in-flight app should be reverted to QUEUED on SIGINT');
    } finally {
      await pool.stop();
    }
  });

  it('APPLYING count in DB never exceeds SUBMISSION_POOL_SIZE during dispatch cycle', async () => {
    const poolSize = 3;
    let totalQueuedApplications = Array.from({ length: 10 }, (_, i) => ({
      id: `app-limit-${i}`,
      applywizz_id: `AWL-${i}`,
      job_url: `https://gh.io/${i}`,
      status: 'QUEUED',
    })) as ApplicationRow[];

    const pool = new SubmitterPool({
      pollIntervalMs: 1000,
      dequeueFn: async () => {
        return totalQueuedApplications.shift() || null;
      },
      updateStatusFn: async () => true,
    });

    try {
      // Run first dispatch
      const firstCycle = await pool.dispatchOnce();
      assert.ok(firstCycle.inFlight <= poolSize, `inFlight (${firstCycle.inFlight}) must never exceed poolSize (${poolSize})`);
      assert.equal(firstCycle.dequeued, 3);

      // Run second dispatch immediately while workers are still busy
      const secondCycle = await pool.dispatchOnce();
      assert.equal(secondCycle.dequeued, 0, 'second dispatch while full must dequeue 0');
      assert.ok(secondCycle.inFlight <= poolSize, `inFlight (${secondCycle.inFlight}) must not exceed poolSize`);

      // Ensure remaining 7 apps were NOT drained into memory
      assert.equal(totalQueuedApplications.length, 7, '7 apps should still remain in the database queue');
    } finally {
      await pool.stop();
    }
  });
});
