import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDashboardApplicationMetrics } from '../src/db/applications/statsQueries.js';

describe('getDashboardApplicationMetrics', () => {
  it('returns application and candidate counts without throwing', async () => {
    const metrics = await getDashboardApplicationMetrics();
    assert.equal(typeof metrics.totalApplications, 'number');
    assert.equal(typeof metrics.totalCandidates, 'number');
  });
});
