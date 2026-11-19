import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractLeverFieldsFromPage, LeverScanner } from '../src/scanner/leverScanner.js';
import { AtsScanFailure } from '../src/scanner/atsScanFailure.js';
import type { Page } from 'playwright';

test('extractLeverFieldsFromPage marks expired when closed text is found', async () => {
  const mockPage = {
    evaluate: async (fn: any) => {
      return true; // isExpired
    },
    waitForSelector: async () => null,
  } as unknown as Page;

  const result = await extractLeverFieldsFromPage(
    mockPage,
    'https://jobs.lever.co/',
    { skipNavigation: true }
  );

  assert.equal(result.isExpired, true);
  assert.equal(result.ats, 'lever');
  assert.equal(result.fields.length, 0);
});

test('extractLeverFieldsFromPage extracts standard fields and custom baseTemplate cards', async () => {
  const sampleCardJson = JSON.stringify({
    text: 'Sponsorship Requirement',
    fields: [
      {
        id: 'field-123',
        text: 'Do you require sponsorship?',
        type: 'multiple-choice',
        required: true,
        options: [{ text: 'Yes' }, { text: 'No' }],
      },
    ],
  });

  const mockPage = {
    evaluate: async (fn: any) => {
      // First call is isExpired check
      if (fn.toString().includes('no job postings currently open')) {
        return false;
      }
      // Second call is rawData extraction
      return {
        companyName: 'FloQast',
        jobTitle: 'Staff Engineer, DevOps',
        categories: ['San Jose, CA'],
        standardFields: [
          { name: 'name', id: 'name', type: 'text', label: 'Full name', required: true },
          { name: 'email', id: 'email', type: 'email', label: 'Email', required: true },
          { name: 'phone', id: 'phone', type: 'text', label: 'Phone', required: true },
          { name: 'location', id: 'location-input', type: 'text', label: 'Current location', required: true },
          { name: 'resume', id: 'resume-upload-input', type: 'file', label: 'Resume/CV', required: true },
        ],
        baseTemplates: [
          { cardId: 'card-abc', json: sampleCardJson },
        ],
      };
    },
    waitForSelector: async () => null,
  } as unknown as Page;

  const result = await extractLeverFieldsFromPage(
    mockPage,
    'https://jobs.lever.co/',
    { skipNavigation: true }
  );

  assert.equal(result.isExpired, false);
  assert.equal(result.ats, 'lever');
  assert.equal(result.companyName, 'FloQast');
  assert.equal(result.jobTitle, 'Staff Engineer, DevOps');

  // Verify standard fields
  assert.equal(result.fields.some((f) => f.name === 'name' && f.type === 'text'), true);
  assert.equal(result.fields.some((f) => f.name === 'email' && f.type === 'text'), true);
  assert.equal(result.fields.some((f) => f.name === 'location' && f.type === 'location_autocomplete'), true);
  assert.equal(result.fields.some((f) => f.name === 'resume' && f.type === 'file'), true);

  // Verify custom card field
  const sponsorshipField = result.fields.find((f) => f.name === 'cards[card-abc][field0]');
  assert.ok(sponsorshipField);
  assert.equal(sponsorshipField.type, 'radio');
  assert.equal(sponsorshipField.label, 'Do you require sponsorship?');
  assert.equal(sponsorshipField.isRequired, true);
  assert.deepEqual(sponsorshipField.options, ['Yes', 'No']);
});

test('Lever treats throttled and temporary HTTP responses as scan failures, not expired jobs', async () => {
  for (const status of [429, 503]) {
    const page = {
      goto: async () => ({ status: () => status, headerValue: async () => status === 429 ? '5' : null }),
    } as unknown as Page;
    await assert.rejects(
      extractLeverFieldsFromPage(page, 'https://jobs.lever.co/', { timeoutMs: 100 }),
      (error: unknown) => error instanceof AtsScanFailure
        && error.kind === (status === 429 ? 'throttled' : 'temporary')
        && error.httpStatus === status
        && error.retryAfterMs === (status === 429 ? 5000 : null),
    );
  }
});

test('Lever preserves HTTP closure and explicit closed-job text', async () => {
  const page = { goto: async () => ({ status: () => 404 }) } as unknown as Page;
  const result = await extractLeverFieldsFromPage(page, 'https://jobs.lever.co/');
  assert.equal(result.isExpired, true);

  const closedCopyPage = {
    evaluate: async () => true,
    waitForSelector: async () => null,
  } as unknown as Page;
  const closedCopy = await extractLeverFieldsFromPage(closedCopyPage, 'https://jobs.lever.co/', { skipNavigation: true });
  assert.equal(closedCopy.isExpired, true);
});

test('Lever interactive verification and missing fields fail without returning an expired template', async () => {
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
  await assert.rejects(
    extractLeverFieldsFromPage(challengePage, 'https://jobs.lever.co/'),
    (error: unknown) => error instanceof AtsScanFailure && error.kind === 'challenge',
  );

  const noFieldsPage = {
    evaluate: async (fn: Function) => fn.toString().includes('no job postings currently open')
      ? false
      : { companyName: '', jobTitle: '', categories: [], standardFields: [], baseTemplates: [] },
    waitForSelector: async () => null,
  } as unknown as Page;
  await assert.rejects(
    extractLeverFieldsFromPage(noFieldsPage, 'https://jobs.lever.co/', { skipNavigation: true }),
    (error: unknown) => error instanceof AtsScanFailure && error.kind === 'extraction',
  );
});

test('Lever worker reports throttling and continues without adding a false expired template', async () => {
  const server = http.createServer((request, response) => {
    if (request.url?.includes('throttled')) {
      response.writeHead(429, { 'retry-after': '3' });
      response.end('rate limited');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<html><body><form id="application-form"><label>Full name<input name="name" required></label></form></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const failed: string[] = [];
    const diagnostics: Array<{ category: string; metadata?: Record<string, unknown> }> = [];
    const scanner = new LeverScanner({ workerPoolSize: 1, minJitterMs: 0, maxJitterMs: 0,
      onScanFailed: (url) => failed.push(url),
      onFailureDiagnostic: async (input) => { diagnostics.push(input); } });
    const results = await scanner.scanUniqueUrls([`${base}/throttled`, `${base}/active`]);
    assert.deepEqual(failed, [`${base}/throttled`]);
    assert.equal(diagnostics[0].category, 'SCAN_HTTP_THROTTLED');
    assert.equal(diagnostics[0].metadata?.httpStatus, 429);
    assert.equal(diagnostics[0].metadata?.retryAfterMs, 3000);
    assert.equal(results.length, 1);
    assert.equal(results[0].jobUrl, `${base}/active`);
    assert.equal(results[0].isExpired, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
