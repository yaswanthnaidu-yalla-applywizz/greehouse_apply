import { describe, it, expect } from 'vitest';
import { selectNextRoundRobinAppInMemory } from '../src/db/applications.js';
import type { ApplicationRow } from '../src/types/index.js';

describe('Round-Robin Dequeue Algorithm', () => {
  it('interleaves applications fairly across distinct candidates', () => {
    const queuedApps: Partial<ApplicationRow>[] = [
      { id: 'app-a1', applywizz_id: 'CAND_A', status: 'QUEUED', submission_order: 1 },
      { id: 'app-a2', applywizz_id: 'CAND_A', status: 'QUEUED', submission_order: 2 },
      { id: 'app-a3', applywizz_id: 'CAND_A', status: 'QUEUED', submission_order: 3 },
      { id: 'app-b1', applywizz_id: 'CAND_B', status: 'QUEUED', submission_order: 4 },
      { id: 'app-c1', applywizz_id: 'CAND_C', status: 'QUEUED', submission_order: 5 },
    ];

    // Round 1 picks:
    // CAND_A's first app (order 1)
    const first = selectNextRoundRobinAppInMemory(queuedApps as ApplicationRow[]);
    expect(first?.id).toBe('app-a1');

    // After app-a1 is dequeued (status -> APPLYING):
    (queuedApps[0] as ApplicationRow).status = 'APPLYING';

    // CAND_B's first app should be preferred over CAND_A's second app because CAND_B is in round 1 (rank 1)
    const second = selectNextRoundRobinAppInMemory(queuedApps as ApplicationRow[]);
    expect(second?.id).toBe('app-b1');

    (queuedApps[3] as ApplicationRow).status = 'APPLYING';

    // CAND_C's first app (rank 1)
    const third = selectNextRoundRobinAppInMemory(queuedApps as ApplicationRow[]);
    expect(third?.id).toBe('app-c1');

    (queuedApps[4] as ApplicationRow).status = 'APPLYING';

    // Now all rank 1 apps are gone; CAND_A's second app (rank 2) is chosen
    const fourth = selectNextRoundRobinAppInMemory(queuedApps as ApplicationRow[]);
    expect(fourth?.id).toBe('app-a2');
  });

  it('handles empty queue or non-QUEUED apps gracefully', () => {
    expect(selectNextRoundRobinAppInMemory([])).toBeNull();
    const nonQueued: Partial<ApplicationRow>[] = [
      { id: 'app-x', applywizz_id: 'CAND_X', status: 'APPLYING', submission_order: 1 },
      { id: 'app-y', applywizz_id: 'CAND_Y', status: 'READY_FOR_REVIEW', submission_order: 2 },
    ];
    expect(selectNextRoundRobinAppInMemory(nonQueued as ApplicationRow[])).toBeNull();
  });
});
