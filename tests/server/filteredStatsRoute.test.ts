import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { devDashboardRouter } from '../../src/server/routes/devDashboard.js';

describe('GET /api/dev/filtered-stats', () => {
  it('returns structured filtered stats for today', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/dev', devDashboardRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dev/filtered-stats?range=day`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toHaveProperty('hasIngestData');
      expect(body).toHaveProperty('topFunnel');
      expect(body).toHaveProperty('bottomFunnel');
      expect(Array.isArray(body.items)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);
});
