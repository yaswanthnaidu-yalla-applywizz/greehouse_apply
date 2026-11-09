import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLatestIngestRunDate, invalidateLatestIngestRunDateCache } from '../src/db/ingestRuns.js';
import { resolveDefaultDashboardDate } from '../src/server/dashboardDateRange.js';
import { candidatesRouter } from '../src/server/routes/candidates.js';

describe('Latest Ingest Run Date Resolution & Candidates Route Fallback', () => {
  it('exports getLatestIngestRunDate and returns a valid ISO date string (YYYY-MM-DD)', async () => {
    assert.equal(typeof getLatestIngestRunDate, 'function');
    assert.equal(typeof invalidateLatestIngestRunDateCache, 'function');
    assert.equal(typeof resolveDefaultDashboardDate, 'function');
    const date = await getLatestIngestRunDate();
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    const defaultDate = await resolveDefaultDashboardDate();
    assert.equal(defaultDate, date);
  });

  it('candidatesRouter sets X-Dashboard-Latest-Date header when date query is omitted', async () => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let jsonBody: any = null;

    const req: any = {
      method: 'GET',
      url: '/',
      query: {},
      headers: {},
    };

    await new Promise<void>((resolve) => {
      const res: any = {
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
        },
        getHeader: (k: string) => headers[k.toLowerCase()],
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (data: any) => {
          jsonBody = data;
          resolve();
          return res;
        },
        send: () => {
          resolve();
          return res;
        },
      };

      candidatesRouter(req, res, () => resolve());
    });

    const expectedDate = await resolveDefaultDashboardDate();
    assert.equal(headers['x-dashboard-latest-date'], expectedDate);
  });
});
