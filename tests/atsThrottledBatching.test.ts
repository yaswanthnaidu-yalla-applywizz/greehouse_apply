import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractAtsHostKey } from '../src/scanner/atsScanFailure.js';
import { LeverScanner } from '../src/scanner/leverScanner.js';

test('Task 4: Host-Quarantine & End-of-Queue Throttled Batching', async (t) => {
  await t.test('extractAtsHostKey groups by multi-tenant company slug and custom domains', () => {
    assert.strictEqual(
      extractAtsHostKey('https://jobs.ashbyhq.com/Globex/123-abc'),
      'jobs.ashbyhq.com/globex'
    );
    assert.strictEqual(
      extractAtsHostKey('https://jobs.ashbyhq.com/globex/456-def'),
      'jobs.ashbyhq.com/globex'
    );
    assert.strictEqual(
      extractAtsHostKey('https://jobs.lever.co/Initech/789-xyz'),
      'jobs.lever.co/initech'
    );
    assert.strictEqual(
      extractAtsHostKey('https://careers.example.com/job/100'),
      'careers.example.com'
    );
    assert.strictEqual(
      extractAtsHostKey('http://127.0.0.1:4000/CompanyA/job1'),
      '127.0.0.1:4000/companya'
    );
  });

  await t.test('quarantines throttled employer host, completes others fast, and retries deferred URLs at queue end', async () => {
    const hits: string[] = [];
    let companyAThrottled = true;

    const server = http.createServer((req, res) => {
      const url = req.url || '';
      hits.push(url);

      if (url.includes('/companyA/')) {
        if (companyAThrottled) {
          res.writeHead(429, { 'retry-after': '1' });
          res.end('Rate limit exceeded');
          return;
        }
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`
        <html><body>
          <form id="application-form">
            <label>Full name <input name="name" required></label>
          </form>
        </body></html>
      `);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;

    const urlA1 = `${base}/companyA/job1`;
    const urlA2 = `${base}/companyA/job2`;
    const urlB1 = `${base}/companyB/job1`;

    try {
      const scanner = new LeverScanner({
        workerPoolSize: 1,
        minJitterMs: 0,
        maxJitterMs: 0,
      });

      // Clear throttle before second pass triggers (simulate cooldown expiration)
      setTimeout(() => {
        companyAThrottled = false;
      }, 1200);

      const results = await scanner.scanAll([urlA1, urlA2, urlB1]);

      // Assertions:
      // 1. urlA2 must NOT be requested during pass 1 while companyA is quarantined
      // In pass 1, hits should be: [urlA1 (429), urlB1 (200)]. urlA2 is deferred WITHOUT network hit!
      // In pass 2 (after cooldown): [urlA1 (200), urlA2 (200)]
      assert.strictEqual(hits.filter((h) => h === '/companyA/job2').length, 1, 'urlA2 should only be hit once in pass 2, never during cooldown in pass 1');

      // 2. All 3 jobs should ultimately be scanned successfully
      assert.strictEqual(results.length, 3);
      const scannedUrls = results.map((r) => r.jobUrl);
      assert.ok(scannedUrls.includes(urlA1));
      assert.ok(scannedUrls.includes(urlA2));
      assert.ok(scannedUrls.includes(urlB1));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
