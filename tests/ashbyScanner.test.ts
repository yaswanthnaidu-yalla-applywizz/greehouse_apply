import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { scanAshbyJob, AshbyScanner } from '../src/scanner/ashbyScanner.js';
import type { Page } from 'playwright';

test('Ashby navigation failure is diagnosed and does not return an expired job', async () => {
  const diagnostics: Array<{ category: string; isRetryable: boolean }> = [];
  const scanner = new AshbyScanner({ onFailureDiagnostic: async (input) => { diagnostics.push(input); } });
  const page = { goto: async () => { throw new Error('net::ERR_CONNECTION_RESET'); } } as unknown as Page;
  const result = await scanner.scanSingleUrl('https://jobs.ashbyhq.com/example/job', page, true);
  assert.equal(result, null);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].category, 'SCAN_PLAYWRIGHT_NAVIGATE');
  assert.equal(diagnostics[0].isRetryable, true);
});

test('Ashby embedded application navigation failure is not classified as expired', async () => {
  const diagnostics: Array<{ category: string; isRetryable: boolean }> = [];
  let navigations = 0;
  const page = {
    goto: async () => {
      if (navigations++ === 0) return { status: () => 200 };
      throw new Error('net::ERR_CONNECTION_RESET');
    },
    url: () => 'https://example.com/careers',
    isClosed: () => false,
    evaluate: async () => ({ surfaces: [], promptNodes: [] }),
    waitForSelector: async () => null,
    frames: () => [{ parentFrame: () => null, url: () => 'https://jobs.ashbyhq.com/example/job' }],
  } as unknown as Page;
  const scanner = new AshbyScanner({ onFailureDiagnostic: async (input) => { diagnostics.push(input); } });
  assert.equal(await scanner.scanSingleUrl('https://example.com/careers?ashby_jid=123', page, true), null);
  assert.equal(diagnostics[0].category, 'SCAN_PLAYWRIGHT_NAVIGATE');
  assert.equal(diagnostics[0].isRetryable, true);
});

test('Ashby navigation with no response is diagnosed instead of marked expired', async () => {
  const diagnostics: Array<{ category: string; isRetryable: boolean }> = [];
  const page = { goto: async () => null } as unknown as Page;
  const scanner = new AshbyScanner({ onFailureDiagnostic: async (input) => { diagnostics.push(input); } });
  assert.equal(await scanner.scanSingleUrl('https://jobs.ashbyhq.com/example/job', page, true), null);
  assert.equal(diagnostics[0].category, 'SCAN_PLAYWRIGHT_NAVIGATE');
  assert.equal(diagnostics[0].isRetryable, true);
});

test('Ashby treats throttled and temporary HTTP responses as failed scans, not expiration', async () => {
  for (const status of [429, 503]) {
    const diagnostics: Array<{ category: string; metadata?: Record<string, unknown> }> = [];
    const page = {
      goto: async () => ({ status: () => status, headerValue: async () => status === 429 ? '30' : null }),
    } as unknown as Page;
    const scanner = new AshbyScanner({ onFailureDiagnostic: async (input) => { diagnostics.push(input); } });
    assert.equal(await scanner.scanSingleUrl('https://jobs.ashbyhq.com/example/job', page, true), null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].category, status === 429 ? 'SCAN_HTTP_THROTTLED' : 'SCAN_TEMPORARY_FAILURE');
    assert.equal(diagnostics[0].metadata?.httpStatus, status);
    if (status === 429) assert.equal(diagnostics[0].metadata?.retryAfterMs, 30_000);
  }
});

test('Ashby preserves real HTTP closure and stops on an interactive verification challenge', async () => {
  const expiredPage = { goto: async () => ({ status: () => 410 }) } as unknown as Page;
  const scanner = new AshbyScanner({ onFailureDiagnostic: async () => {} });
  assert.equal((await scanner.scanSingleUrl('https://jobs.ashbyhq.com/example/job', expiredPage, true))?.isExpired, true);

  const challengePage = {
    goto: async () => ({ status: () => 403, headerValue: async () => null }),
    isClosed: () => false,
    evaluate: async () => ({
      surfaces: [],
      visibleHumanPrompt: false,
      visiblePuzzlePrompt: true,
      hasVerificationCopy: true,
    }),
    frames: () => [],
  } as unknown as Page;
  const diagnostics: Array<{ category: string }> = [];
  const challengeScanner = new AshbyScanner({ onFailureDiagnostic: async (input) => { diagnostics.push(input); } });
  assert.equal(await challengeScanner.scanSingleUrl('https://jobs.ashbyhq.com/example/job', challengePage, true), null);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].category, 'SCAN_INTERACTIVE_CHALLENGE');
});

test('Ashby batch continues after a navigation failure without returning an expired template', async () => {
  const server = http.createServer((request, response) => {
    if (request.url?.includes('broken')) { request.socket.destroy(); return; }
    if (request.url?.includes('throttled')) { response.writeHead(429, { 'retry-after': '2' }); response.end('slow down'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<html><head><title>Engineer @ Example</title></head><body><div data-field-path="name"><label>Name</label><input></div></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const failures: string[] = [];
    const scanner = new AshbyScanner({ workerPoolSize: 1, minJitterMs: 0, maxJitterMs: 0,
      onFailureDiagnostic: async () => {}, onScanFailed: (url) => failures.push(url) });
    const results = await scanner.scanUniqueUrls([`${base}/broken`, `${base}/working`]);
    assert.deepEqual(failures, [`${base}/broken`]);
    assert.equal(results.length, 1);
    assert.equal(results[0].jobUrl, `${base}/working`);
    assert.equal(results[0].isExpired, false);
    assert.equal(results[0].fields.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Ashby batch does not persist a throttled URL as an expired template and continues', async () => {
  const server = http.createServer((request, response) => {
    if (request.url?.includes('throttled')) { response.writeHead(503); response.end('temporarily unavailable'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<html><head><title>Engineer @ Example</title></head><body><div data-field-path="name"><label>Name</label><input></div></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const failed: string[] = [];
    const scanned: Array<{ url: string; expired: boolean }> = [];
    const scanner = new AshbyScanner({ workerPoolSize: 1, minJitterMs: 0, maxJitterMs: 0,
      onFailureDiagnostic: async () => {}, onScanFailed: (url) => failed.push(url),
      onJobScanned: (job) => scanned.push({ url: job.jobUrl, expired: job.isExpired }) });
    const results = await scanner.scanUniqueUrls([`${base}/throttled`, `${base}/active`]);
    assert.deepEqual(failed, [`${base}/throttled`]);
    assert.deepEqual(scanned, [{ url: `${base}/active`, expired: false }]);
    assert.equal(results.some((job) => job.jobUrl.endsWith('/throttled')), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Ashby production scanner matches the tracked required/optional DOM fixture', async () => {
  const fixture = await fs.readFile(new URL('./fixtures/ashby-required-optional.html', import.meta.url), 'utf8');
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const template = await scanAshbyJob(`http://127.0.0.1:${address.port}/example/job`);
    assert.equal(template.companyName, 'Example');
    assert.deepEqual(template.fields.map((field) => [field.fieldId, field.type, field.isRequired]), [
      ['_systemfield_resume', 'file', true],
      ['custom_optional', 'select', false],
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Ashby does not let a partial Yes marker override a real location select', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><title>Engineer @ Example</title></head><body>
      <div data-field-path="location_question">
        <label>What city do you live in?</label>
        <button data-option="yes" hidden>Yes</button>
        <select><option>New York</option><option>London</option></select>
      </div>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const template = await scanAshbyJob(`http://127.0.0.1:${address.port}/example/job`);
    const field = template.fields.find((candidate) => candidate.fieldId === 'location_question');
    assert.ok(field);
    assert.equal(field.type, 'select');
    assert.deepEqual(field.options, ['New York', 'London']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Ashby rejects an active form with zero fields as a scan failure', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<html><head><title>No Fields @ Example</title></head><body><p>No application fields here</p></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(
      async () => {
        await scanAshbyJob(`http://127.0.0.1:${address.port}/example/job`);
      },
      /Scan failed: Ashby form yielded zero fields/
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Ashby extracts ordered posting facts and classifies system widgets conservatively', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<html><head><title>Senior Engineer @ Example</title></head><body>
      <header>
        <div>Location</div>
        <div>New York City Office</div>
        <div>Address</div>
        <div>123 Broadway</div>
        <div>Location Type</div>
        <div>Hybrid</div>
      </header>
      <div data-field-path="_systemfield_resume"><label>Resume *</label><input type="file"></div>
      <div data-field-path="_systemfield_education_history"><label>Education History</label><input type="checkbox"></div>
      <div data-field-path="custom_consent"><label>Consent</label><input type="checkbox"></div>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const template = await scanAshbyJob(`http://127.0.0.1:${address.port}/example/job`);
    assert.equal(template.jobPostingLocation, 'New York City Office');
    assert.deepEqual(template.jobPostingFacts?.locations, ['New York City Office']);
    assert.equal(template.jobPostingFacts?.raw?.locationType, 'Hybrid');

    const edu = template.fields.find((f) => f.fieldId === '_systemfield_education_history');
    assert.ok(edu);
    assert.equal(edu.classification, 'system_widget');

    const consent = template.fields.find((f) => f.fieldId === 'custom_consent');
    assert.ok(consent);
    assert.equal(consent.classification, 'answerable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('AshbyScanner scans multiple URLs in parallel with worker pool and progress tracking', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    const path = request.url || '';
    if (path.includes('job-1')) {
      response.end(`<html><head><title>Backend Engineer @ TechCo 1</title></head><body>
        <div data-field-path="_systemfield_resume"><label>Resume *</label><input type="file"></div>
        <div data-field-path="experience"><label>Years of Experience *</label><input type="text"></div>
      </body></html>`);
    } else if (path.includes('job-2')) {
      response.end(`<html><head><title>Frontend Engineer @ TechCo 2</title></head><body>
        <div data-field-path="_systemfield_resume"><label>Resume *</label><input type="file"></div>
        <div data-field-path="portfolio"><label>Portfolio URL</label><input type="text"></div>
      </body></html>`);
    } else if (path.includes('job-3')) {
      // Expired / empty form
      response.end(`<html><head><title>Closed Job @ TechCo 3</title></head><body>
        <p>This position is no longer accepting applications.</p>
      </body></html>`);
    } else {
      response.statusCode = 404;
      response.end('Not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const urls = [`${base}/jobs/job-1`, `${base}/jobs/job-2`, `${base}/jobs/job-3`];

    const progressReports: Array<{ completed: number; total: number; expired: boolean }> = [];

    const scanner = new AshbyScanner({
      workerPoolSize: 3,
      minJitterMs: 0,
      maxJitterMs: 0,
      onJobScanned: (job, completed, total) => {
        progressReports.push({ completed, total, expired: job.isExpired });
      },
    });

    const templates = await scanner.scanUniqueUrls(urls);

    assert.equal(templates.length, 3);
    assert.equal(templates[0].companyName, 'TechCo 1');
    assert.equal(templates[0].jobTitle, 'Backend Engineer');
    assert.equal(templates[0].isExpired, false);
    assert.equal(templates[0].fields.length, 2);

    assert.equal(templates[1].companyName, 'TechCo 2');
    assert.equal(templates[1].jobTitle, 'Frontend Engineer');
    assert.equal(templates[1].isExpired, false);
    assert.equal(templates[1].fields.length, 2);

    // Job 3 had no fields -> marked expired
    assert.equal(templates[2].isExpired, true);
    assert.equal(templates[2].fields.length, 0);

    // Verify progress tracking was invoked for all 3 URLs
    assert.equal(progressReports.length, 3);
    assert.equal(progressReports[2].total, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


