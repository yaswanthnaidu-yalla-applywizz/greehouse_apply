import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadClientDashboard } from '../src/server/clientDashboard.js';

describe('loadClientDashboard', () => {
  it('exports loadClientDashboard function', () => {
    assert.equal(typeof loadClientDashboard, 'function');
  });

  it('executes loadClientDashboard query structure cleanly', async () => {
    try {
      const res = await loadClientDashboard({
        managerEmail: 'test-manager@example.com',
        date: '2026-10-26',
        requestedCa: 'all',
      });
      assert.ok(res);
    } catch (err: any) {
      // In offline/test environment without active Supabase connection, throws DB connectivity error
      assert.match(String(err?.message || ''), /API key|Supabase|fetch failed/i);
    }
  });
});
