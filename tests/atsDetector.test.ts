import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAshbyUrl,
  isGreenhouseUrl,
  isLeverUrl,
  toLeverApplicationUrl,
  extractLeverJobIds,
  extractAshbyJobIds,
} from '../src/scanner/atsDetector.js';

test('detects jobs.ashbyhq.com as Ashby', () => {
  assert.equal(isAshbyUrl('https://jobs.ashbyhq.com/constructor/630a1c38-e1be-48f9-a565-fcfdd3db6f24'), true);
  assert.equal(isAshbyUrl('https://jobs.ashbyhq.com/constructor/630a1c38-e1be-48f9-a565-fcfdd3db6f24?utm_source=LinkedInPaid'), true);
});

test('detects ashby_jid query param as Ashby', () => {
  assert.equal(isAshbyUrl('https://www.sandboxaq.com/careers-list?ashby_jid=5d096708-36f4-4f94-96b9-59b5e9b88f3f'), true);
});

test('detects Greenhouse URL', () => {
  assert.equal(isGreenhouseUrl('https://job-boards.greenhouse.io/pmg/jobs/8765658002'), true);
  assert.equal(isGreenhouseUrl('https://boards.greenhouse.io/embed/job_app?token=123'), true);
  assert.equal(isGreenhouseUrl('https://grnh.se/abcd123'), true);
  assert.equal(isGreenhouseUrl('https://www.crossriver.com/greenhouse?gh_jid=7666383003'), true);
  assert.equal(isAshbyUrl('https://job-boards.greenhouse.io/pmg/jobs/8765658002'), false);
});

test('extracts jobPostingId and orgSlug from standard Ashby URL', () => {
  const ids = extractAshbyJobIds('https://jobs.ashbyhq.com/constructor/630a1c38-e1be-48f9-a565-fcfdd3db6f24?utm_source=LinkedInPaid');
  assert.equal(ids?.jobPostingId, '630a1c38-e1be-48f9-a565-fcfdd3db6f24');
  assert.equal(ids?.orgSlug, 'constructor');
});

test('returns null for custom-domain Ashby URL (no org slug in path)', () => {
  const ids = extractAshbyJobIds('https://www.sandboxaq.com/careers-list?ashby_jid=5d096708-36f4-4f94-96b9-59b5e9b88f3f');
  assert.equal(ids, null);
});

test('extracts UUID from /application path variant', () => {
  const ids = extractAshbyJobIds('https://jobs.ashbyhq.com/chainalysis-careers/78975a32-c00f-4b1b-bc4e-2462857d0a5a/application?utm_source=Mv2N4DagVn');
  assert.equal(ids?.jobPostingId, '78975a32-c00f-4b1b-bc4e-2462857d0a5a');
  assert.equal(ids?.orgSlug, 'chainalysis-careers');
});

test('detects jobs.lever.co as Lever', () => {
  assert.equal(isLeverUrl('https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654'), true);
  assert.equal(isLeverUrl('https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654/apply'), true);
  assert.equal(isLeverUrl('https://api.lever.co/v0/postings/floqast'), true);
  assert.equal(isLeverUrl('https://job-boards.greenhouse.io/pmg/jobs/8765658002'), false);
  assert.equal(isLeverUrl('https://jobs.ashbyhq.com/constructor/630a1c38-e1be-48f9-a565-fcfdd3db6f24'), false);
});

test('canonicalizes Lever job URL to /apply route', () => {
  assert.equal(
    toLeverApplicationUrl('https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654'),
    'https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654/apply'
  );
  assert.equal(
    toLeverApplicationUrl('https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654/apply'),
    'https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654/apply'
  );
  assert.equal(
    toLeverApplicationUrl('https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654?lever-source=linkedin'),
    'https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654/apply?lever-source=linkedin'
  );
});

test('extracts company and jobId from Lever URLs', () => {
  const ids = extractLeverJobIds('https://jobs.lever.co/floqast/63fb5622-9e07-4fde-b73b-dca1081ef654');
  assert.deepEqual(ids, { company: 'floqast', jobId: '63fb5622-9e07-4fde-b73b-dca1081ef654' });

  const apiIds = extractLeverJobIds('https://api.lever.co/v0/postings/zoox/8befaec7-bb9f-4cf3-a48c-46b5e3886bf3');
  assert.deepEqual(apiIds, { company: 'zoox', jobId: '8befaec7-bb9f-4cf3-a48c-46b5e3886bf3' });
});

