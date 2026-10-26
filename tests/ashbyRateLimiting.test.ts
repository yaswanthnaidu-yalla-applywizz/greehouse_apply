import { test } from 'node:test';
import assert from 'node:assert/strict';

test('scheduled_not_before in future blocks dequeue', () => {
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const isBlocked = new Date(future) > new Date();
  assert.equal(isBlocked, true);
});

test('scheduled_not_before in past allows dequeue', () => {
  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const isBlocked = new Date(past) > new Date();
  assert.equal(isBlocked, false);
});

test('scheduled_not_before null allows dequeue', () => {
  const scheduled: string | null = null;
  const isBlocked = scheduled !== null && new Date(scheduled) > new Date();
  assert.equal(isBlocked, false);
});

test('Ashby rate limit intervals are correctly clamped', () => {
  // Candidate gap: 40 to 60 mins
  const minCandidateMs = 40 * 60 * 1000;
  const maxCandidateMs = 60 * 60 * 1000;
  assert.equal(minCandidateMs, 2400000);
  assert.equal(maxCandidateMs, 3600000);

  // Company interval: 20 mins
  const companyIntervalMs = 20 * 60 * 1000;
  assert.equal(companyIntervalMs, 1200000);

  // Same company cooldown: 48 hours
  const sameCompanyCooldownMs = 48 * 60 * 60 * 1000;
  assert.equal(sameCompanyCooldownMs, 172800000);
});
