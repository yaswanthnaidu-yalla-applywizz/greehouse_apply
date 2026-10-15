import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';

const state = vi.hoisted(() => ({ reportPath: '' }));
vi.mock('../src/scanner/ingestFilterReport.js', () => ({
  getCurrentIngestFilterReportPath: () => state.reportPath,
}));

import { devDashboardRouter } from '../src/server/routes/devDashboard.js';

let directory = '';
let server: Server | null = null;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-ingest-report-'));
  state.reportPath = path.join(directory, 'current.csv');
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  }
  server = null;
  await fs.rm(directory, { recursive: true, force: true });
});

async function getReport(query = ''): Promise<Response> {
  const app = express();
  app.use('/api/dev', devDashboardRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${address.port}/api/dev/ingest-filter-report${query}`);
}

describe('Dev dashboard ingestion filter report download', () => {
  it('downloads the fixed current CSV with attachment headers', async () => {
    await fs.writeFile(state.reportPath, 'section,awl_id,job_url\r\nclearance,,https://example.test/1\r\n');

    const response = await getReport();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('ingest-filter-report.csv');
    expect(await response.text()).toContain('clearance,,https://example.test/1');
  });

  it('returns 404 when no current report exists', async () => {
    const response = await getReport();
    expect(response.status).toBe(404);
  });

  it('does not use a caller-supplied path query parameter', async () => {
    await fs.writeFile(state.reportPath, 'fixed report');
    const response = await getReport('?path=../../package.json');
    expect(await response.text()).toBe('fixed report');
  });

  it('exposes an authenticated dashboard download control using the current report endpoint', async () => {
    const html = await readFile(path.resolve('dashboard/public/dev.html'), 'utf8');
    expect(html).toContain('Download current ingest filter report');
    expect(html).toContain("fetch('/api/dev/ingest-filter-report'");
    expect(html).toContain('ApplyWizzRoles.getAuthHeaders()');
    expect(html).toContain('response.blob()');
  });
});
