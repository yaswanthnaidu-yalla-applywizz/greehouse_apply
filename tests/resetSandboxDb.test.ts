import assert from 'node:assert/strict';
import test from 'node:test';
import { resetSandboxDatabase } from '../scripts/resetSandboxDbCore.js';

test('sandbox test mode refuses reset before constructing or calling a database client', async () => {
  let clientFactoryCalls = 0;
  let clientCalls = 0;

  await assert.rejects(
    resetSandboxDatabase({
      testMode: true,
      databaseUrl: 'postgresql://hostile.example:5432/postgres?dbname=other',
      createClient: () => {
        clientFactoryCalls += 1;
        return {
          connect: async () => { clientCalls += 1; },
          query: async () => { clientCalls += 1; },
          end: async () => { clientCalls += 1; },
        };
      },
      log: { info: () => {}, error: () => {} },
      exit: () => { throw new Error('unexpected exit'); },
    }),
    /disabled in SANDBOX_TEST_MODE/
  );

  assert.equal(clientFactoryCalls, 0);
  assert.equal(clientCalls, 0);
});
