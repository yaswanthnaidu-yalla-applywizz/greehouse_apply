import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSandboxTestDatabaseIdentity,
  assertSandboxTestModeConfiguration,
  isSandboxTestMode,
} from '../src/config/sandboxTestMode.js';

test('sandbox test mode requires the explicit flag and sandbox mode', () => {
  const before = { sandbox: process.env.SANDBOX, testMode: process.env.SANDBOX_TEST_MODE };
  try {
    process.env.SANDBOX = 'true';
    delete process.env.SANDBOX_TEST_MODE;
    assert.equal(isSandboxTestMode(), false);
    process.env.SANDBOX_TEST_MODE = 'true';
    assert.equal(isSandboxTestMode(), true);
    process.env.SANDBOX_TEST_MODE = '1';
    assert.equal(isSandboxTestMode(), true);
    process.env.SANDBOX = 'false';
    assert.equal(isSandboxTestMode(), false);
    assert.throws(assertSandboxTestModeConfiguration, /requires SANDBOX=true/);
  } finally {
    if (before.sandbox === undefined) delete process.env.SANDBOX;
    else process.env.SANDBOX = before.sandbox;
    if (before.testMode === undefined) delete process.env.SANDBOX_TEST_MODE;
    else process.env.SANDBOX_TEST_MODE = before.testMode;
  }
});

test('sandbox test mode accepts only localhost applywizz_sandbox database URLs', () => {
  assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost:5432/applywizz_sandbox');
  assertSandboxTestDatabaseIdentity('postgresql://user:password@[::1]:5432/applywizz_sandbox?sslmode=disable');
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@example.com:5432/applywizz_sandbox'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost:5432/postgres'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost:5432/applywizz_sandbox?host=example.com'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost:5432/applywizz_sandbox?hostaddr=127.0.0.1'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost:5432/applywizz_sandbox?port=5433'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost/applywizz_sandbox?port=5433'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('postgresql://user:password@localhost:5432/applywizz_sandbox?dbname=postgres'),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseIdentity('/var/run/postgresql applywizz_sandbox'),
    /local applywizz_sandbox/
  );
});

test('sandbox test mode validates the connected database and both socket endpoints', async () => {
  const { assertSandboxTestDatabaseConnection } = await import('../src/config/sandboxTestMode.js');
  assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: '127.0.0.1', remoteAddress: '127.0.0.1' });
  assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: '::1', remoteAddress: '::1' });
  assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: '127.0.0.1/8', remoteAddress: '127.0.0.1' });
  assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: '::1/128', remoteAddress: '::1' });
  assert.throws(
    () => assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: '10.0.0.4', remoteAddress: '127.0.0.1' }),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: '127.0.0.1', remoteAddress: '10.0.0.4' }),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseConnection({ database: 'postgres', serverAddress: '127.0.0.1', remoteAddress: '127.0.0.1' }),
    /local applywizz_sandbox/
  );
  assert.throws(
    () => assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress: null, remoteAddress: null }),
    /local applywizz_sandbox/
  );
  for (const serverAddress of ['10.0.0.4/8', '127.0.0.1/33', '::1/129', '::1/not-a-prefix', '::1/128/1']) {
    assert.throws(
      () => assertSandboxTestDatabaseConnection({ database: 'applywizz_sandbox', serverAddress, remoteAddress: '127.0.0.1' }),
      /local applywizz_sandbox/
    );
  }
});

test('sandbox test mode rejects queue insertion before reading application state', async () => {
  const before = { sandbox: process.env.SANDBOX, testMode: process.env.SANDBOX_TEST_MODE };
  try {
    process.env.SANDBOX = 'true';
    process.env.SANDBOX_TEST_MODE = 'true';
    const { enqueueApplication } = await import('../src/db/applications/queue.js');
    await assert.rejects(() => enqueueApplication('not-an-application'), /disabled in sandbox test mode/);
  } finally {
    if (before.sandbox === undefined) delete process.env.SANDBOX;
    else process.env.SANDBOX = before.sandbox;
    if (before.testMode === undefined) delete process.env.SANDBOX_TEST_MODE;
    else process.env.SANDBOX_TEST_MODE = before.testMode;
  }
});
