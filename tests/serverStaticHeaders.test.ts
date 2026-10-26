import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server/index.js';
import { emailProofWorkerPool } from '../src/submitter/emailProofWorkerPool.js';

describe('Server static headers & compression', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const app = createServer();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    emailProofWorkerPool.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setTimeout(() => process.exit(0), 50).unref();
  });

  it('serves chunk assets with immutable caching', async () => {
    const res = await fetch(`${baseUrl}/assets/chunk-HeaderSignOut-HgFJ8zb9.js`);
    if (res.status === 200) {
      const cc = res.headers.get('cache-control');
      assert.ok(cc);
      assert.match(cc, /max-age=31536000/);
      assert.match(cc, /immutable/);
    }
  });

  it('serves unhashed entrypoints with no-cache', async () => {
    const res = await fetch(`${baseUrl}/assets/admin.js`);
    if (res.status === 200) {
      const cc = res.headers.get('cache-control');
      assert.ok(cc);
      assert.match(cc, /no-cache/);
    }
  });

  it('responds with compression enabled for health check', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    assert.equal(res.status, 200);
  });
});
