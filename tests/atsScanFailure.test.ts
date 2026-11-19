import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAtsNavigationStatus, parseRetryAfter } from '../src/scanner/atsScanFailure.js';

test('classifies ATS navigation status without treating transient responses as expired', () => {
  assert.equal(classifyAtsNavigationStatus(200), 'ok');
  assert.equal(classifyAtsNavigationStatus(399), 'ok');
  assert.equal(classifyAtsNavigationStatus(404), 'expired');
  assert.equal(classifyAtsNavigationStatus(410), 'expired');
  assert.equal(classifyAtsNavigationStatus(429), 'throttled');
  assert.equal(classifyAtsNavigationStatus(503), 'temporary');
  assert.equal(classifyAtsNavigationStatus(500), 'temporary');
  assert.equal(classifyAtsNavigationStatus(403), 'blocked');
});

test('parses Retry-After seconds and HTTP dates as a nonnegative wait', () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');
  assert.equal(parseRetryAfter('12', now), 12_000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:27:08 GMT', now), 8_000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:26:00 GMT', now), 0);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('tomorrow-ish', now), null);
  assert.equal(parseRetryAfter('999999999999999999999999', now), null);
});
