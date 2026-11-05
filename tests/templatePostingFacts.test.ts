import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAshbyApplicationUrl } from '../src/scanner/atsDetector.js';
import { getTemplateByUrl } from '../src/db/templates.js';

test('toAshbyApplicationUrl canonicalizes tracked query URLs correctly', () => {
  const urlWithTrack = 'https://jobs.ashbyhq.com/org/78975a32-c00f-4b1b-bc4e-2462857d0a5a?utm_source=LinkedIn';
  const expected = 'https://jobs.ashbyhq.com/org/78975a32-c00f-4b1b-bc4e-2462857d0a5a/application?utm_source=LinkedIn';
  assert.equal(toAshbyApplicationUrl(urlWithTrack), expected);

  const alreadyApp = 'https://jobs.ashbyhq.com/org/78975a32-c00f-4b1b-bc4e-2462857d0a5a/application?utm_source=LinkedIn';
  assert.equal(toAshbyApplicationUrl(alreadyApp), expected);
});

test('toAshbyApplicationUrl provides parity for scanner and submitter', () => {
  const rawUrl = 'https://jobs.ashbyhq.com/org/78975a32-c00f-4b1b-bc4e-2462857d0a5a/';
  const canonical = toAshbyApplicationUrl(rawUrl);
  assert.equal(canonical, 'https://jobs.ashbyhq.com/org/78975a32-c00f-4b1b-bc4e-2462857d0a5a/application');
});

test('toAshbyApplicationUrl returns null for custom-domain URLs with ashby_jid', () => {
  const customUrl = 'https://www.sandboxaq.com/careers-list?ashby_jid=5d096708-36f4-4f94-96b9-59b5e9b88f3f';
  assert.equal(toAshbyApplicationUrl(customUrl), null);
});

test('legacy row without posting facts hydrates gracefully', async () => {
  const legacyRow = {
    job_url: 'https://job-boards.greenhouse.io/test/jobs/12345',
    company_name: 'TestCo',
    job_title: 'Engineer',
    fields_schema: [],
    is_expired: false,
  };
  assert.equal(legacyRow.job_url, 'https://job-boards.greenhouse.io/test/jobs/12345');
  assert.equal((legacyRow as any).job_posting_location, undefined);
  assert.equal((legacyRow as any).job_posting_facts, undefined);
});

test('row construction and hydration preserves posting facts', () => {
  const template = {
    jobUrl: 'https://job-boards.greenhouse.io/test/jobs/12345',
    companyName: 'TestCo',
    jobTitle: 'Engineer',
    fields: [],
    scannedAt: '2026-11-05T00:00:00Z',
    isExpired: false,
    jobPostingLocation: 'Remote - USA',
    jobPostingFacts: {
      location: 'Remote - USA',
      locations: ['Remote - USA'],
      raw: { job_post_location: 'Remote - USA' },
    },
  };

  const exportedRow = {
    job_url: template.jobUrl,
    company_name: template.companyName,
    job_title: template.jobTitle,
    fields_schema: template.fields,
    is_expired: template.isExpired,
    scanned_at: template.scannedAt,
    updated_at: '2026-11-05T00:00:00Z',
    ats: 'greenhouse',
    job_posting_location: template.jobPostingLocation,
    job_posting_facts: template.jobPostingFacts,
  };

  assert.equal(exportedRow.job_posting_location, 'Remote - USA');
  assert.deepEqual(exportedRow.job_posting_facts?.locations, ['Remote - USA']);
});

