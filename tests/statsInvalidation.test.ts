import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

export function shouldEmitStatsInvalidation(
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  oldRow?: {
    status?: string;
    created_at?: string;
    applywizz_id?: string;
    assigned_ca_email?: string | null;
    first_attempted_at?: string | null;
  },
  newRow?: {
    status?: string;
    created_at?: string;
    applywizz_id?: string;
    assigned_ca_email?: string | null;
    first_attempted_at?: string | null;
  }
): boolean {
  if (op === 'INSERT' || op === 'DELETE') return true;
  if (!oldRow || !newRow) return false;

  return (
    oldRow.status !== newRow.status ||
    oldRow.created_at !== newRow.created_at ||
    oldRow.applywizz_id !== newRow.applywizz_id ||
    oldRow.assigned_ca_email !== newRow.assigned_ca_email ||
    oldRow.first_attempted_at !== newRow.first_attempted_at
  );
}

describe('database stats invalidation contract', () => {
  it('emits invalidation on INSERT and DELETE', () => {
    assert.equal(shouldEmitStatsInvalidation('INSERT'), true);
    assert.equal(shouldEmitStatsInvalidation('DELETE'), true);
  });

  it('emits invalidation when status changes from FAILED to APPLIED', () => {
    const oldRow = {
      status: 'FAILED',
      created_at: '2026-10-26T00:00:00Z',
      applywizz_id: 'AWL-1',
      assigned_ca_email: 'op@example.com',
      first_attempted_at: '2026-10-26T01:00:00Z',
    };
    const newRow = {
      ...oldRow,
      status: 'APPLIED',
    };
    assert.equal(shouldEmitStatsInvalidation('UPDATE', oldRow, newRow), true);
  });

  it('emits invalidation when first_attempted_at is set for the first time', () => {
    const oldRow = {
      status: 'READY_FOR_REVIEW',
      created_at: '2026-10-26T00:00:00Z',
      applywizz_id: 'AWL-1',
      assigned_ca_email: 'op@example.com',
      first_attempted_at: null,
    };
    const newRow = {
      ...oldRow,
      first_attempted_at: '2026-10-26T01:00:00Z',
    };
    assert.equal(shouldEmitStatsInvalidation('UPDATE', oldRow, newRow), true);
  });

  it('suppresses invalidation on no-op updates (e.g. proof updates, timestamp bumps)', () => {
    const oldRow = {
      status: 'APPLIED',
      created_at: '2026-10-26T00:00:00Z',
      applywizz_id: 'AWL-1',
      assigned_ca_email: 'op@example.com',
      first_attempted_at: '2026-10-26T01:00:00Z',
    };
    const newRow = {
      ...oldRow,
    };
    assert.equal(shouldEmitStatsInvalidation('UPDATE', oldRow, newRow), false);
  });
});
