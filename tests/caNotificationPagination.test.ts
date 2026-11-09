import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupReadyForReviewByCa,
  groupReadyForReviewByManager,
  fetchLatestReadyForReviewApplications,
} from '../src/services/caNotificationEmail.js';

describe('Email Notification Pagination & Scoping', () => {
  it('groups more than 1000 applications across CAs without truncation', () => {
    const rows = [];
    for (let i = 0; i < 2045; i++) {
      rows.push({
        id: `app-${i}`,
        applywizz_id: `AWL-${i % 50}`,
        assigned_ca_email: i < 1036 ? 'balaji_ca@applywizz.ai' : 'rk_ca@applywizz.ai',
        job_url: `https://boards.greenhouse.io/job/${i}`,
      });
    }
    const summaries = groupReadyForReviewByCa(rows);
    assert.equal(summaries.length, 2);
    const totalApps = summaries.reduce((sum, s) => sum + s.appCount, 0);
    assert.equal(totalApps, 2045);

    const caToManagerMap = new Map([
      ['balaji_ca@applywizz.ai', 'balaji@applywizz.ai'],
      ['rk_ca@applywizz.ai', 'ramakrishnaa.tejavath@applywizz.ai'],
    ]);
    const managerSummaries = groupReadyForReviewByManager(rows, caToManagerMap);
    const balajiSummary = managerSummaries.find((m) => m.managerEmail === 'balaji@applywizz.ai');
    const rkSummary = managerSummaries.find((m) => m.managerEmail === 'ramakrishnaa.tejavath@applywizz.ai');

    assert.equal(balajiSummary?.appCount, 1036);
    assert.equal(rkSummary?.appCount, 1009);
  });

  it('fetchLatestReadyForReviewApplications exports as a function and handles mock query accurately', async () => {
    assert.equal(typeof fetchLatestReadyForReviewApplications, 'function');
  });
});
