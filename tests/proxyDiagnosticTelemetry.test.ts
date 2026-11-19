import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyProxyPreflight } from '../src/submitter/ashbyProxy.js';

test('Task 6: Network & Proxy Preflight Diagnostics', async (t) => {
  await t.test('preflight against healthy server records latencyMs and no errorKind', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ip: '198.51.100.42' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpointUrl = `http://127.0.0.1:${address.port}/ip`;

    const mockPage: any = {
      request: {
        get: async (url: string) => {
          return {
            ok: () => true,
            status: () => 200,
            json: async () => ({ ip: '198.51.100.42' }),
          };
        },
      },
    };

    try {
      const result = await verifyProxyPreflight(mockPage, undefined, { endpointUrl, timeoutMs: 1000 });
      assert.strictEqual(result.success, true);
      assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0);
      assert.strictEqual(result.errorKind, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await t.test('preflight against HTTP 403 provider block records errorKind: http_block', async () => {
    const mockPage: any = {
      request: {
        get: async () => {
          return {
            ok: () => false,
            status: () => 403,
            json: async () => ({ error: 'Forbidden' }),
          };
        },
      },
    };

    const result = await verifyProxyPreflight(mockPage, undefined, {
      endpointUrl: 'http://127.0.0.1:9999/ip',
      timeoutMs: 1000,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorKind, 'http_block');
    assert.ok(typeof result.latencyMs === 'number');
  });

  await t.test('preflight against connection refused records errorKind: tcp_reset', async () => {
    const mockPage: any = {
      request: {
        get: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:59999');
        },
      },
    };

    const result = await verifyProxyPreflight(mockPage, undefined, {
      endpointUrl: 'http://127.0.0.1:59999/ip',
      timeoutMs: 1000,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorKind, 'tcp_reset');
    assert.ok(typeof result.latencyMs === 'number');
  });

  await t.test('preflight against timeout records errorKind: timeout', async () => {
    const mockPage: any = {
      request: {
        get: async () => {
          throw new Error('Preflight probe timed out after 500ms');
        },
      },
    };

    const result = await verifyProxyPreflight(mockPage, undefined, {
      endpointUrl: 'http://127.0.0.1:9999/ip',
      timeoutMs: 500,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorKind, 'timeout');
  });
});
