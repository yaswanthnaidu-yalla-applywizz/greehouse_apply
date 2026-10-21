import { describe, it, expect } from 'vitest';
import http from 'http';
import express from 'express';
import { candidatesRouter } from '../src/server/routes/candidates.js';

describe('Candidates Router Mounting & Wildcards', () => {
  it('exports candidatesRouter as an express Router', () => {
    expect(typeof candidatesRouter).toBe('function');
  });

  it('routes requests through the router without double prefixing', async () => {
    const app = express();
    app.use('/api/candidates', candidatesRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/candidates`);
    // Should hit router handler (not 404 unhandled by express)
    expect(res.status).not.toBe(404);

    const wildcardRes = await fetch(`http://127.0.0.1:${port}/api/candidates/AWL-TEST/jobs/https://boards.greenhouse.io/test/jobs/1`);
    expect(wildcardRes.status).not.toBe(404);

    server.close();
  });
});
