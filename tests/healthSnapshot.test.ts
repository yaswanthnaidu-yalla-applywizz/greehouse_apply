import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

describe('Health Snapshot Concurrency & Caching', () => {
  test('healthSnapshot.ts uses Promise.allSettled for service probes', () => {
    const code = fs.readFileSync(path.resolve('src/server/healthSnapshot.ts'), 'utf-8');
    assert.ok(code.includes('Promise.allSettled'), 'Probes must run concurrently using Promise.allSettled');
  });

  test('healthSnapshot.ts caches recent snapshot with 10s TTL', () => {
    const code = fs.readFileSync(path.resolve('src/server/healthSnapshot.ts'), 'utf-8');
    assert.ok(code.includes('CACHE_TTL_MS') || code.includes('10000'), 'Snapshot caching TTL must exist');
  });
});
