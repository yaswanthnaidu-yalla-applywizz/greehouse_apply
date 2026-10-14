import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETAINED_APPLICATION_STATUSES,
  buildRetainedStatusFilter,
  runStatsRollup,
} from '../src/db/statsRollup.js';
import { setDbClient } from '../src/db/client.js';

test('statsRollupPruning constants and filter formatting', () => {
  assert.deepEqual(RETAINED_APPLICATION_STATUSES, ['APPLIED', 'EMAIL_PROOF_PENDING']);
  assert.equal(buildRetainedStatusFilter(), '("APPLIED","EMAIL_PROOF_PENDING")');
});

test('runStatsRollup filters non-retained applications and prunes templates', async () => {
  const calls: { table: string; method: string; args: unknown[] }[] = [];

  const fakeDb: any = {
    from: (table: string) => {
      calls.push({ table, method: 'from', args: [table] });

      if (table === 'gh_stats_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { value: '2026-04-01' },
                error: null,
              }),
            }),
          }),
        };
      }

      if (table === 'gh_candidate_applications') {
        return {
          delete: () => ({
            not: (column: string, op: string, value: string) => {
              calls.push({ table, method: 'not', args: [column, op, value] });
              return {
                select: async () => ({
                  data: [{ id: 'app-1' }],
                  error: null,
                }),
              };
            },
          }),
        };
      }

      if (table === 'gh_scanned_job_templates') {
        return {
          delete: () => ({
            not: (column: string, op: string, value: unknown) => {
              calls.push({ table, method: 'not', args: [column, op, value] });
              return {
                select: async () => ({
                  data: [{ id: 'tmpl-1' }],
                  error: null,
                }),
              };
            },
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  setDbClient(fakeDb);

  try {
    await runStatsRollup();

    const appNotCall = calls.find(
      (c) => c.table === 'gh_candidate_applications' && c.method === 'not'
    );
    assert.ok(appNotCall, 'Expected .not() on gh_candidate_applications');
    assert.deepEqual(appNotCall.args, [
      'status',
      'in',
      '("APPLIED","EMAIL_PROOF_PENDING")',
    ]);

    const tmplNotCall = calls.find(
      (c) => c.table === 'gh_scanned_job_templates' && c.method === 'not'
    );
    assert.ok(tmplNotCall, 'Expected .not() on gh_scanned_job_templates');
    assert.deepEqual(tmplNotCall.args, ['id', 'is', null]);
  } finally {
    setDbClient(null);
  }
});
