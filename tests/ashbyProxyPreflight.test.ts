import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Page } from 'playwright';
import { verifyProxyPreflight } from '../src/submitter/ashbyProxy.js';

function createMockPage(handler: (url: string, options?: any) => Promise<any>): Page {
  return {
    request: {
      get: handler,
    },
  } as unknown as Page;
}

test('returns success: true and a valid 12-char hex exitIpHash when response returns valid IP', async () => {
  const mockIp = '198.51.100.42';
  const expectedHash = crypto.createHash('sha256').update(mockIp).digest('hex').slice(0, 12);
  const requestedUrls: string[] = [];

  const page = createMockPage(async (url: string, options?: any) => {
    requestedUrls.push(url);
    return {
      ok: () => true,
      status: () => 200,
      json: async () => ({ ip: mockIp }),
    };
  });

  const result = await verifyProxyPreflight(page);

  assert.equal(result.success, true);
  assert.equal(result.outcome, 'success');
  assert.equal(result.exitIpHash, expectedHash);
  assert.equal(result.exitIpHash?.length, 12);
  assert.match(result.exitIpHash!, /^[a-f0-9]{12}$/);
  assert.equal(result.error, undefined);
  assert.ok(requestedUrls.length > 0);
  assert.ok(requestedUrls.every((url) => new URL(url).search === ''), 'default probes must not include query strings');
});

test('returns failure when every no-query probe receives HTTP 400', async () => {
  const requestedUrls: string[] = [];
  const page = createMockPage(async (url: string) => {
    requestedUrls.push(url);
    return { ok: () => false, status: () => 400, json: async () => ({ error: 'Bad Request' }) };
  });

  const result = await verifyProxyPreflight(page);

  assert.equal(result.success, false);
  assert.equal(result.outcome, 'http_status');
  assert.match(result.error || '', /status 400/i);
  assert.ok(requestedUrls.length > 1, 'HTTP 400 should try the compatible fallback');
  assert.ok(requestedUrls.every((url) => new URL(url).search === ''), 'fallback probes must not include query strings');
});

test('returns success: false with error message when mock request rejects with network error', async () => {
  const page = createMockPage(async () => {
    throw new Error('Connection reset by peer');
  });

  const result = await verifyProxyPreflight(page);

  assert.equal(result.success, false);
  assert.equal(result.outcome, 'network_error');
  assert.equal(result.exitIpHash, undefined);
  assert.match(result.error || '', /Connection reset by peer/i);
});

test('returns success: false when request times out', async () => {
  // Use a small timeoutMs option so test completes quickly
  const page = createMockPage(async () => {
    return new Promise((resolve) => setTimeout(resolve, 300));
  });

  const result = await verifyProxyPreflight(page, undefined, { timeoutMs: 50 });

  assert.equal(result.success, false);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.exitIpHash, undefined);
  assert.match(result.error || '', /time.*out/i);
});

test('returns success: false when probe returns non-200 HTTP status', async () => {
  const page = createMockPage(async () => ({
    ok: () => false,
    status: () => 502,
    json: async () => ({ error: 'Bad Gateway' }),
  }));

  const result = await verifyProxyPreflight(page);

  assert.equal(result.success, false);
  assert.equal(result.outcome, 'http_status');
  assert.equal(result.exitIpHash, undefined);
  assert.match(result.error || '', /status 502/i);
});

test('returns success: false when response JSON does not contain a valid IP', async () => {
  const page = createMockPage(async () => ({
    ok: () => true,
    status: () => 200,
    json: async () => ({ ip: 'not-an-ip' }),
  }));

  const result = await verifyProxyPreflight(page);

  assert.equal(result.success, false);
  assert.equal(result.outcome, 'invalid_ip');
  assert.equal(result.exitIpHash, undefined);
  assert.match(result.error || '', /IP/i);
});

test('verifies country code matches when provided by endpoint', async () => {
  const pageMatching = createMockPage(async () => ({
    ok: () => true,
    status: () => 200,
    json: async () => ({ ip: '198.51.100.42', country: 'US' }),
  }));

  const resOk = await verifyProxyPreflight(pageMatching, 'us');
  assert.equal(resOk.success, true);

  const pageMismatch = createMockPage(async () => ({
    ok: () => true,
    status: () => 200,
    json: async () => ({ ip: '198.51.100.42', country: 'DE' }),
  }));

  const resMismatch = await verifyProxyPreflight(pageMismatch, 'us');
  assert.equal(resMismatch.success, false);
  assert.equal(resMismatch.outcome, 'country_mismatch');
  assert.match(resMismatch.error || '', /country mismatch/i);
});
