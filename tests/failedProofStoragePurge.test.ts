import test from 'node:test';
import assert from 'node:assert/strict';
import { setDbClient } from '../src/db/client.js';
import { purgeFailedProofStorage } from '../src/services/failedProofStoragePurge.js';

test('purgeFailedProofStorage blocks when an ingest run is currently running', async () => {
  const fakeDb: any = {
    from: (table: string) => {
      if (table === 'ingest_runs') {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [{ id: 'run-1' }], error: null }),
            }),
          }),
        };
      }
      return {};
    },
  };

  setDbClient(fakeDb);
  try {
    await assert.rejects(
      async () => {
        await purgeFailedProofStorage({ preview: false });
      },
      /Cannot purge failed screenshots while an ingestion run is currently in progress/
    );
  } finally {
    setDbClient(null);
  }
});

test('purgeFailedProofStorage blocks when applications are in APPLYING status', async () => {
  const fakeDb: any = {
    from: (table: string) => {
      if (table === 'ingest_runs') {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === 'gh_candidate_applications') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'status' && val === 'APPLYING') {
                return {
                  limit: async () => ({ data: [{ id: 'app-active-1' }], error: null }),
                };
              }
              return { limit: async () => ({ data: [], error: null }) };
            },
          }),
        };
      }
      return {};
    },
  };

  setDbClient(fakeDb);
  try {
    await assert.rejects(
      async () => {
        await purgeFailedProofStorage({ preview: false });
      },
      /Cannot purge failed screenshots while submission workers are actively processing applications/
    );
  } finally {
    setDbClient(null);
  }
});

test('purgeFailedProofStorage preview mode counts files without deleting storage or updating applications', async () => {
  const removedFiles: string[] = [];
  const updatedApps: any[] = [];

  const fakeDb: any = {
    from: (table: string) => {
      if (table === 'ingest_runs') {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === 'gh_candidate_applications') {
        return {
          select: (_cols: string, opts?: any) => {
            if (opts?.head && opts?.count === 'exact') {
              return {
                eq: () => ({
                  not: async () => ({ count: 12, error: null }),
                }),
              };
            }
            return {
              eq: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            };
          },
          update: (payload: any) => ({
            eq: () => ({
              not: async () => {
                updatedApps.push(payload);
                return { error: null };
              },
            }),
          }),
        };
      }
      return {};
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, 'proofs_failed');
        return {
          list: async (_prefix: string, opts?: any) => {
            if (opts?.offset === 0) {
              return {
                data: [
                  { name: 'app-1_failed.png', metadata: { size: 1024 } },
                  { name: 'app-2_failed.png', metadata: { size: 2048 } },
                ],
                error: null,
              };
            }
            return { data: [], error: null };
          },
          remove: async (files: string[]) => {
            removedFiles.push(...files);
            return { data: files.map((f) => ({ name: f })), error: null };
          },
        };
      },
    },
  };

  setDbClient(fakeDb);
  try {
    const result = await purgeFailedProofStorage({ preview: true });
    assert.equal(result.preview, true);
    assert.equal(result.totalFound, 2);
    assert.equal(result.freedBytesApprox, 3072);
    assert.equal(result.updatedApplications, 12);
    assert.equal(result.deletedCount, 0);
    assert.equal(removedFiles.length, 0, 'No files should be removed in preview mode');
    assert.equal(updatedApps.length, 0, 'No applications should be updated in preview mode');
  } finally {
    setDbClient(null);
  }
});

test('purgeFailedProofStorage confirm mode deletes storage objects and updates failed applications', async () => {
  const removedFiles: string[] = [];
  const updatedApps: any[] = [];
  const auditEvents: any[] = [];

  let pageCallCount = 0;

  const fakeDb: any = {
    from: (table: string) => {
      if (table === 'ingest_runs') {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === 'gh_candidate_applications') {
        return {
          select: (_cols: string, opts?: any) => {
            if (opts?.head && opts?.count === 'exact') {
              return {
                eq: () => ({
                  not: async () => ({ count: 5, error: null }),
                }),
              };
            }
            return {
              eq: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            };
          },
          update: (payload: any) => ({
            eq: (col: string, val: string) => {
              assert.equal(col, 'status');
              assert.equal(val, 'FAILED');
              return {
                not: async (notCol: string, notOp: string, notVal: any) => {
                  assert.equal(notCol, 'proof_failed_url');
                  assert.equal(notOp, 'is');
                  assert.equal(notVal, null);
                  updatedApps.push(payload);
                  return { error: null };
                },
              };
            },
          }),
        };
      }
      if (table === 'gh_audit_events') {
        return {
          insert: async (row: any) => {
            auditEvents.push(row);
            return { error: null };
          },
        };
      }
      return {};
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, 'proofs_failed');
        return {
          list: async (_prefix: string, opts?: any) => {
            // Assert that offset is always 0 on deletion
            assert.equal(opts?.offset, 0, 'offset must stay at 0 to prevent pagination shift');
            pageCallCount++;
            if (pageCallCount === 1) {
              return {
                data: [
                  { name: 'failed-1.png', metadata: { size: 5000 } },
                  { name: 'failed-2.png', metadata: { size: 5000 } },
                ],
                error: null,
              };
            }
            return { data: [], error: null };
          },
          remove: async (files: string[]) => {
            removedFiles.push(...files);
            return { data: files.map((f) => ({ name: f })), error: null };
          },
        };
      },
    },
  };

  setDbClient(fakeDb);
  try {
    const result = await purgeFailedProofStorage({
      preview: false,
      actorEmail: 'admin@applywizz.ai',
      actorRole: 'admin',
    });

    assert.equal(result.preview, false);
    assert.equal(result.deletedCount, 2);
    assert.equal(result.freedBytesApprox, 10000);
    assert.equal(result.updatedApplications, 5);
    assert.deepEqual(removedFiles, ['failed-1.png', 'failed-2.png']);
    assert.equal(updatedApps.length, 1);
    assert.equal(updatedApps[0].proof_failed_url, null);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].action, 'FAILED_PROOFS_PURGED');
    assert.equal(auditEvents[0].metadata.deletedScreenshots, 2);
  } finally {
    setDbClient(null);
  }
});
