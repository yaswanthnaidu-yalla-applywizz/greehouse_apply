import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAndDeduplicateUrls } from '../src/scanner/csvDeduplicator.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('deduplicates duplicate and tracking-decorated job URLs within an ingest batch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-dedup-'));
  const csvFile = path.join(tmpDir, 'test_jobs.csv');

  const content = `url,applywizz_id
https://jobs.lever.co/acme/123?utm_source=linkedin,AWL-1
https://jobs.lever.co/acme/123?utm_campaign=winter,AWL-2
https://jobs.lever.co/acme/123,AWL-3
https://jobs.ashbyhq.com/globex/456?gh_src=test,AWL-1
https://jobs.ashbyhq.com/globex/456,AWL-2
https://boards.greenhouse.io/initech/jobs/789?utm_medium=cpc,AWL-1
https://boards.greenhouse.io/initech/jobs/789,AWL-3
`;

  fs.writeFileSync(csvFile, content, 'utf-8');

  try {
    const urls = await readAndDeduplicateUrls(csvFile, { resolveShortlinks: false });
    assert.equal(urls.length, 3, '7 rows with 3 unique canonical postings must yield exactly 3 URLs');
    assert.ok(urls.includes('https://jobs.lever.co/acme/123'));
    assert.ok(urls.includes('https://jobs.ashbyhq.com/globex/456'));
    assert.ok(urls.includes('https://boards.greenhouse.io/initech/jobs/789'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
