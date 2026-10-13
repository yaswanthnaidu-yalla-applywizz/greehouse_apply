import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countAiFields,
  countUnresolvedRequiredFields,
  applicationShouldBeFilteredOut,
  applicationNeedsOperatorReview,
} from '../src/resolver/needsReview.js';
import {
  filterOperatorApplicationJobs,
  excludeSkippedApplicationJobs,
  isFilteredOutApplicationJob,
} from '../src/dashboard/candidateQueueFilter.js';
import { statusMetricsForTransition } from '../src/db/applicationStats.js';

describe('FILTERED_OUT routing logic', () => {
  it('countAiFields counts all AI fields regardless of isRequired', () => {
    const fields = [
      { isRequired: true, source: 'ai' },
      { isRequired: false, source: 'ai' },
      { isRequired: true, source: 'supabase' },
      { isRequired: false, source: 'unresolved' },
    ];
    assert.equal(countAiFields(fields), 2);
  });

  it('countUnresolvedRequiredFields only counts required unresolved fields', () => {
    const fields = [
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: null },
      { isRequired: false, source: 'unresolved' }, // optional, ignored
      { isRequired: true, source: 'supabase' },     // resolved, ignored
      { isRequired: true, source: 'ai' },           // resolved, ignored
    ];
    assert.equal(countUnresolvedRequiredFields(fields), 2);
  });

  it('routes to auto-queue (QUEUED) when 0 AI and 0 unresolved', () => {
    const fields = [
      { isRequired: true, source: 'supabase', label: 'First Name', value: 'John' },
      { isRequired: true, source: 'resume_parse', label: 'Email', value: 'john@example.com' },
      { isRequired: false, source: 'supabase', label: 'Website', value: 'https://example.com' },
    ];
    assert.equal(applicationShouldBeFilteredOut(fields), false);
    assert.equal(applicationNeedsOperatorReview(fields), false);
  });

  it('routes to READY_FOR_REVIEW when any required field is solved by AI (not auto-queued and not filtered out)', () => {
    const fields = [
      { isRequired: true, source: 'ai', confidence: 0.9, label: 'Custom Question', value: 'Answer' },
      { isRequired: true, source: 'supabase', label: 'First Name', value: 'John' },
    ];
    assert.equal(applicationShouldBeFilteredOut(fields), false);
    assert.equal(applicationNeedsOperatorReview(fields), true); // true = requires operator review (READY_FOR_REVIEW)
  });

  it('does NOT filter out when AI <= 3 even if unresolved required > 3', () => {
    const fields = [
      { isRequired: true, source: 'ai', confidence: 0.9 },
      { isRequired: true, source: 'ai', confidence: 0.9 },
      { isRequired: false, source: 'ai', confidence: 0.9 }, // total AI = 3
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },           // total unresolved req = 4 (> 3)
    ];
    assert.equal(applicationShouldBeFilteredOut(fields), false);
  });

  it('does NOT filter out when unresolved required <= 3 even if AI > 3', () => {
    const fields = [
      { isRequired: true, source: 'ai', confidence: 0.9 },
      { isRequired: true, source: 'ai', confidence: 0.9 },
      { isRequired: false, source: 'ai', confidence: 0.9 },
      { isRequired: false, source: 'ai', confidence: 0.9 }, // total AI = 4 (> 3)
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },           // total unresolved req = 2 (<= 3)
    ];
    assert.equal(applicationShouldBeFilteredOut(fields), false);
  });

  it('FILTERS OUT when both AI > 3 AND unresolved required > 3', () => {
    const fields = [
      { isRequired: true, source: 'ai', confidence: 0.9 },
      { isRequired: true, source: 'ai', confidence: 0.9 },
      { isRequired: false, source: 'ai', confidence: 0.9 },
      { isRequired: false, source: 'ai', confidence: 0.9 }, // total AI = 4 (> 3)
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },
      { isRequired: true, source: 'unresolved' },           // total unresolved req = 4 (> 3)
    ];
    assert.equal(applicationShouldBeFilteredOut(fields), true);
  });
});

describe('FILTERED_OUT dashboard exclusion', () => {
  it('filterOperatorApplicationJobs strips both QUEUED and FILTERED_OUT jobs', () => {
    const jobs = [
      { status: 'READY_FOR_REVIEW', resolved_fields: [] },
      { status: 'QUEUED', resolved_fields: [] },
      { status: 'FILTERED_OUT', resolved_fields: [] },
      { status: 'filtered_out', resolved_fields: [] },
      { status: 'APPLIED', resolved_fields: [] },
    ];
    const filtered = filterOperatorApplicationJobs(jobs);
    assert.equal(filtered.length, 2);
    assert.equal(filtered.some((j) => j.status === 'READY_FOR_REVIEW'), true);
    assert.equal(filtered.some((j) => j.status === 'APPLIED'), true);
    assert.equal(filtered.some((j) => (j.status || '').toUpperCase() === 'FILTERED_OUT'), false);
    assert.equal(filtered.some((j) => (j.status || '').toUpperCase() === 'QUEUED'), false);
  });

  it('excludeSkippedApplicationJobs strips both SKIPPED and FILTERED_OUT', () => {
    const jobs = [
      { status: 'READY_FOR_REVIEW' },
      { status: 'SKIPPED' },
      { status: 'FILTERED_OUT' },
      { status: 'APPLIED' },
    ];
    const filtered = excludeSkippedApplicationJobs(jobs);
    assert.equal(filtered.length, 2);
    assert.equal(filtered.some((j) => j.status === 'READY_FOR_REVIEW'), true);
    assert.equal(filtered.some((j) => j.status === 'APPLIED'), true);
  });

  it('isFilteredOutApplicationJob identifies FILTERED_OUT status case-insensitively', () => {
    assert.equal(isFilteredOutApplicationJob({ status: 'FILTERED_OUT' }), true);
    assert.equal(isFilteredOutApplicationJob({ status: 'filtered_out' }), true);
    assert.equal(isFilteredOutApplicationJob({ status: 'READY_FOR_REVIEW' }), false);
  });

  it('statusMetricsForTransition does not count FILTERED_OUT as submitted', () => {
    const metrics = statusMetricsForTransition('FILTERED_OUT');
    assert.deepEqual(metrics, []);
  });
});
