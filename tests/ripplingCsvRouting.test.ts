import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRipplingUrl } from '../src/scanner/csvDeduplicator.js';

test('normalizes Rippling CSV URLs to the application route and preserves query parameters', () => {
  const input = 'https://ats.rippling.com/en-US/acme/jobs/12345678-1234-4234-8234-123456789abc?jobId=job-42&token=apply-token&source=campaign&utm_medium=email#details';

  assert.equal(
    normalizeRipplingUrl(input),
    'https://ats.rippling.com/en-US/acme/jobs/12345678-1234-4234-8234-123456789abc/apply?jobId=job-42&token=apply-token&source=campaign&utm_medium=email'
  );
});

test('normalizes Rippling application URLs idempotently', () => {
  const input = 'https://ats.rippling.com/acme/jobs/12345678-1234-4234-8234-123456789abc/apply?token=apply-token';
  assert.equal(normalizeRipplingUrl(normalizeRipplingUrl(input)), normalizeRipplingUrl(input));
});

test('rejects unsupported Rippling URLs', () => {
  assert.equal(normalizeRipplingUrl('https://ats.rippling.com/acme/jobs/not-a-uuid'), '');
});
