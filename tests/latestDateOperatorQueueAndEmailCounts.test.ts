import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getLatestIngestRunDate } from '../src/db/ingestRuns.js';
import { resolveDefaultDashboardDate, parseDashboardStatsRange } from '../src/server/dashboardDateRange.js';
import { fetchLatestReadyForReviewApplications } from '../src/services/caNotificationEmail.js';

describe('End-to-End Verification: Ingest Run Latest Date Queue & Email Pagination', () => {
  it('1. Authoritatively resolves latest ingest run date as valid IST calendar date', async () => {
    const latestDate = await getLatestIngestRunDate();
    assert.match(latestDate, /^\d{4}-\d{2}-\d{2}$/);

    const defaultDashboardDate = await resolveDefaultDashboardDate();
    assert.equal(defaultDashboardDate, latestDate);
  });

  it('2. fetchLatestReadyForReviewApplications paginates in chunks of 1000 and avoids truncation', async () => {
    const totalApps = 2045;
    const mockDb: any[] = Array.from({ length: totalApps }, (_, i) => ({
      applywizz_id: `AWL-${i + 1}`,
      assigned_ca_email: `ca_${i % 47}@applywizz.ai`,
      status: 'READY_FOR_REVIEW',
      job_url: `https://boards.greenhouse.io/test/jobs/${i + 1}`,
      company_name: `Company ${i + 1}`,
      job_title: `Role ${i + 1}`,
      created_at: '2026-11-08T18:00:00.000Z',
    }));

    let queryCalls = 0;
    const mockSupabase: any = {
      from: (_table: string) => ({
        select: (_cols: string) => ({
          eq: (_field: string, _val: string) => ({
            gte: (_field2: string, _val2: string) => ({
              lte: (_field3: string, _val3: string) => ({
                range: (from: number, to: number) => {
                  queryCalls++;
                  const slice = mockDb.slice(from, to + 1);
                  return Promise.resolve({ data: slice, error: null });
                },
              }),
            }),
          }),
        }),
      }),
    };

    const results = await fetchLatestReadyForReviewApplications('2026-11-08', mockSupabase);
    assert.equal(results.length, totalApps);
    assert.equal(queryCalls, 3); // 0-999, 1000-1999, 2000-2044
  });

  it('3. Manager and Admin date range parsing preserves custom ranges without alteration', () => {
    const customQuery = { from: '2026-11-01', to: '2026-11-05' };
    const parsed = parseDashboardStatsRange(customQuery);
    assert.ok(!('error' in parsed));
    assert.equal(parsed.preset, 'custom');
    assert.equal(parsed.fromDate, '2026-11-01');
    assert.equal(parsed.toDate, '2026-11-05');
  });

  it('4. Operator dashboard header exposes a date picker and application date', () => {
    const headerPath = path.resolve(process.cwd(), 'dashboard/components/Header/DashboardHeader.tsx');
    const headerCode = fs.readFileSync(headerPath, 'utf8');

    assert.match(headerCode, /data-testid="application-date-picker"/);
    assert.match(headerCode, /data-testid="latest-batch-badge"/);
    assert.match(headerCode, /Application Date/);
  });
});
