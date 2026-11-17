import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ResolverProgressTracker, type ResolverProgressSnapshot } from '../src/resolver/progressTracker.js';

describe('ResolverProgressTracker', () => {
  test('initializes with default zeroed snapshots', () => {
    const tracker = new ResolverProgressTracker({ forceInteractive: false });
    const snapshot = tracker.getSnapshot();

    assert.strictEqual(snapshot.tier14.completed, 0);
    assert.strictEqual(snapshot.tier14.total, 0);
    assert.strictEqual(snapshot.tier14.fieldsResolved, 0);
    assert.strictEqual(snapshot.tier14.tier5Escaped, 0);
    assert.strictEqual(snapshot.tier5.stage, 'idle');
    assert.strictEqual(snapshot.tier5.completedItems, 0);
  });

  test('tracks Tier 1-4 progress correctly', () => {
    const snapshots: ResolverProgressSnapshot[] = [];
    const tracker = new ResolverProgressTracker({
      forceInteractive: false,
      onProgress: (snap) => snapshots.push(snap),
    });

    tracker.startTier14(100);
    tracker.updateTier14({ completedDelta: 10, fieldsResolvedDelta: 45, tier5EscapedDelta: 2 });
    tracker.updateTier14({ completedDelta: 15, fieldsResolvedDelta: 60, tier5EscapedDelta: 1, skippedDelta: 3 });

    const snap = tracker.getSnapshot();
    assert.strictEqual(snap.tier14.total, 100);
    assert.strictEqual(snap.tier14.completed, 25);
    assert.strictEqual(snap.tier14.fieldsResolved, 105);
    assert.strictEqual(snap.tier14.tier5Escaped, 3);
    assert.strictEqual(snap.tier14.skipped, 3);
    assert.ok(snapshots.length >= 3);
  });

  test('tracks Tier 5 batch stages and updates', () => {
    const snapshots: ResolverProgressSnapshot[] = [];
    const tracker = new ResolverProgressTracker({
      forceInteractive: false,
      onProgress: (snap) => snapshots.push(snap),
    });

    tracker.startTier5Stage('haiku', 50, 'initial batch');
    let snap = tracker.getSnapshot();
    assert.strictEqual(snap.tier5.stage, 'haiku');
    assert.strictEqual(snap.tier5.status, 'submitting');
    assert.strictEqual(snap.tier5.totalItems, 50);

    tracker.updateTier5Batch({
      status: 'polling',
      batchId: 'msgbatch_123',
      completedItems: 20,
    });
    snap = tracker.getSnapshot();
    assert.strictEqual(snap.tier5.status, 'polling');
    assert.strictEqual(snap.tier5.batchId, 'msgbatch_123');
    assert.strictEqual(snap.tier5.completedItems, 20);

    tracker.updateTier5Batch({
      status: 'completed',
      completedItems: 50,
      acceptedCount: 42,
      escalatedCount: 8,
    });
    snap = tracker.getSnapshot();
    assert.strictEqual(snap.tier5.status, 'completed');
    assert.strictEqual(snap.tier5.acceptedCount, 42);
    assert.strictEqual(snap.tier5.escalatedCount, 8);
  });

  test('handles interactive render calls without throwing', () => {
    const tracker = new ResolverProgressTracker({ forceInteractive: true });
    assert.doesNotThrow(() => {
      tracker.startTier14(50);
      tracker.updateTier14({ completedDelta: 25, fieldsResolvedDelta: 100, tier5EscapedDelta: 5 });
      tracker.completeTier14();
      tracker.startTier5Stage('haiku', 10);
      tracker.updateTier5Batch({ status: 'polling', batchId: 'batch_test', completedItems: 5 });
      tracker.updateTier5Batch({ status: 'completed', completedItems: 10, acceptedCount: 10 });
      tracker.finish();
    });
  });
});
