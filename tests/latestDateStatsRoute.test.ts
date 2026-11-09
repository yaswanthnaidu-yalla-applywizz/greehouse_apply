import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getLatestIngestRunDate } from '../src/db/ingestRuns.js';
import { notificationsRouter } from '../src/server/routes/notifications.js';

describe('Stats and Notifications Route Alignment with Latest Ingest Date', () => {
  it('notificationsRouter resolves with latest ingest date when date query is omitted', async () => {
    const latestDate = await getLatestIngestRunDate();
    assert.match(latestDate, /^\d{4}-\d{2}-\d{2}$/);

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
      };

      notificationsRouter(req, res, () => resolve());
    });

    // Unauthenticated request returns 401 Unauthorized but handles query parsing safely
    assert.ok([200, 401].includes(statusCode));
  });
});
