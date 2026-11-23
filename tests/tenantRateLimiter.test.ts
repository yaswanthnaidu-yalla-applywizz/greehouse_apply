import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTenantKey, TenantRateLimiter } from '../src/submitter/tenantRateLimiter.js';

test('extractTenantKey groups multi-tenant ATS company slugs correctly', () => {
  assert.equal(
    extractTenantKey('https://jobs.ashbyhq.com/Clera/2d1cadd3-9212-46cf-be7d-bb220dad8710'),
    'jobs.ashbyhq.com/clera'
  );
  assert.equal(
    extractTenantKey('https://jobs.ashbyhq.com/airwallex/bd91b283-8de0-41bd-aba4-8cae281808a7'),
    'jobs.ashbyhq.com/airwallex'
  );
  assert.equal(
    extractTenantKey('https://job-boards.greenhouse.io/alixpartners/jobs/8213796003'),
    'job-boards.greenhouse.io/alixpartners'
  );
  assert.equal(
    extractTenantKey('https://boards.greenhouse.io/hasbro/jobs/123'),
    'boards.greenhouse.io/hasbro'
  );
  assert.equal(
    extractTenantKey('https://jobs.lever.co/initech/abc'),
    'jobs.lever.co/initech'
  );
  assert.equal(
    extractTenantKey({ company_name: 'Clera' }),
    'company:clera'
  );
});

test('TenantRateLimiter tracks cooldown and calculates remaining time accurately', async () => {
  const limiter = new TenantRateLimiter(500); // 500ms interval for fast testing
  const tenant = 'jobs.ashbyhq.com/testcompany';

  // Initially not under cooldown
  assert.equal(limiter.isUnderCooldown(tenant), false);
  assert.equal(limiter.getRemainingCooldownMs(tenant), 0);

  // Record submission
  limiter.recordSubmission(tenant);
  assert.equal(limiter.isUnderCooldown(tenant), true);
  assert.ok(limiter.getRemainingCooldownMs(tenant) > 0);

  // Wait for cooldown
  const start = Date.now();
  await limiter.waitForCooldown(tenant, 100);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 90, `Elapsed ${elapsed}ms should be at least ~100ms`);

  limiter.reset();
  assert.equal(limiter.isUnderCooldown(tenant), false);
});

test('TenantRateLimiter escalates cooldown on interactive CAPTCHA record', async () => {
  const limiter = new TenantRateLimiter(500);
  const tenant = 'jobs.ashbyhq.com/clera';

  assert.equal(limiter.isUnderCooldown(tenant), false);

  // Escalate cooldown by 1500ms
  limiter.recordCaptcha(tenant, 1500);
  assert.equal(limiter.isUnderCooldown(tenant), true);
  const remaining = limiter.getRemainingCooldownMs(tenant);
  assert.ok(remaining > 1000 && remaining <= 1500, `Remaining ${remaining}ms should reflect escalated penalty`);

  limiter.reset(tenant);
  assert.equal(limiter.isUnderCooldown(tenant), false);
});
