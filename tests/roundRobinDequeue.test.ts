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

  it('prevents candidate starvation across simulated concurrent worker dispatches', () => {
    // Candidate 1 has 10 applications, Candidate 2 has 2, Candidate 3 has 1
    const pool: ApplicationRow[] = [];
    for (let i = 1; i <= 10; i++) {
      pool.push({
        id: `c1-app-${i}`,
        applywizz_id: 'CAND_1',
        status: 'QUEUED',
        submission_order: i,
      } as ApplicationRow);
    }
    for (let i = 1; i <= 2; i++) {
      pool.push({
        id: `c2-app-${i}`,
        applywizz_id: 'CAND_2',
        status: 'QUEUED',
        submission_order: 10 + i,
      } as ApplicationRow);
    }
    pool.push({
      id: 'c3-app-1',
      applywizz_id: 'CAND_3',
      status: 'QUEUED',
      submission_order: 13,
    } as ApplicationRow);

    // Simulate 3 workers dispatching from the pool round-robin
    const dispatchedIds: string[] = [];
    while (true) {
      const next = selectNextRoundRobinAppInMemory(pool);
      if (!next) break;
      next.status = 'APPLYING';
      dispatchedIds.push(next.id || '');
    }

    // Total dispatched count must match total apps (13)
    expect(dispatchedIds.length).toBe(13);

    // Round 1: first app from CAND_1, CAND_2, CAND_3
    expect(dispatchedIds.slice(0, 3)).toEqual(['c1-app-1', 'c2-app-1', 'c3-app-1']);

    // Round 2: second app from CAND_1, CAND_2 (CAND_3 has none left)
    expect(dispatchedIds.slice(3, 5)).toEqual(['c1-app-2', 'c2-app-2']);

    // Round 3+: remaining apps from CAND_1
    expect(dispatchedIds[5]).toBe('c1-app-3');
    expect(dispatchedIds[12]).toBe('c1-app-10');
  });
});
