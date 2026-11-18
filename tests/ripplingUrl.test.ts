import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRipplingUrl, toRipplingApplicationUrl } from '../src/scanner/atsDetector.js';

test('recognizes and converts supported Rippling job URLs without discarding query parameters', () => {
  const job = 'https://ats.rippling.com/en-CA/company/jobs/12345678-1234-4234-8234-123456789abc?source=direct';
  assert.equal(isRipplingUrl(job), true);
  assert.equal(toRipplingApplicationUrl(job), 'https://ats.rippling.com/en-CA/company/jobs/12345678-1234-4234-8234-123456789abc/apply?source=direct');
  assert.equal(toRipplingApplicationUrl(toRipplingApplicationUrl(job)!), toRipplingApplicationUrl(job));
});

test('rejects non-Rippling hosts and paths that are not job pages', () => {
  assert.equal(isRipplingUrl('https://ats.rippling.com.evil.example/company/jobs/12345678-1234-4234-8234-123456789abc'), false);
  assert.equal(isRipplingUrl('https://ats.rippling.com/company/jobs'), false);
  assert.equal(toRipplingApplicationUrl('https://ats.rippling.com/company/jobs/not-a-uuid'), null);
});
