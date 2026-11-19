import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAndDeduplicateUrls } from '../src/scanner/csvDeduplicator.js';

test('CSV ingestion excludes Rippling URLs instead of routing them to Greenhouse', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rippling-routing-'));
  const csvPath = path.join(directory, 'jobs.csv');
  fs.writeFileSync(csvPath, [
    'applywizz_id,job_url',
    'AWL-1,https://ats.rippling.com/acme/jobs/12345678-1234-4234-8234-123456789abc',
    'AWL-2,https://ats.rippling.com/acme/jobs/not-a-job',
    'AWL-3,https://boards.greenhouse.io/acme/jobs/123',
    'AWL-4,https://careers.example.com/openings/456',
    'AWL-5,https://jobs.ashbyhq.com/acme/12345678-1234-4234-8234-123456789abc',
  ].join('\n'));

  try {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    let urls: string[];
    try {
      urls = await readAndDeduplicateUrls(csvPath, { resolveShortlinks: false });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(urls, [
      'https://boards.greenhouse.io/acme/jobs/123',
      'https://careers.example.com/openings/456',
      'https://jobs.ashbyhq.com/acme/12345678-1234-4234-8234-123456789abc',
    ]);
    assert.ok(warnings.some((warning) => warning.includes('Rippling') && warning.includes('not-a-job')));
    assert.ok(warnings.some((warning) => warning.includes('12345678-1234-4234-8234-123456789abc')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
