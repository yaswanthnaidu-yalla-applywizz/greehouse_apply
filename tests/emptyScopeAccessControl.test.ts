import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getRecentNotifications } from '../src/db/applications/notifications.js';
import { getSubmissionOutcomeCounts, getDashboardApplicationMetrics } from '../src/db/applications/statsQueries.js';

describe('Empty Scope Access Control Isolation', () => {
  test('getRecentNotifications returns empty array when allowedCandidateIds is empty array', async () => {
    const res = await getRecentNotifications(50, { allowedCandidateIds: [] });
    assert.deepEqual(res, [], 'Empty restricted scope must return zero notifications');
  });

  test('getSubmissionOutcomeCounts returns 0 counts when allowedCandidateIds is empty array', async () => {
    const res = await getSubmissionOutcomeCounts({ allowedCandidateIds: [] });
    assert.equal(res.successfulApplications, 0);
    assert.equal(res.failedApplications, 0);
  });

  test('getDashboardApplicationMetrics returns zeroed metrics when allowedCandidateIds is empty array', async () => {
    const res = await getDashboardApplicationMetrics({ allowedCandidateIds: [] });
    assert.equal(res.totalApplications, 0);
    assert.equal(res.totalCandidates, 0);
  });
});
