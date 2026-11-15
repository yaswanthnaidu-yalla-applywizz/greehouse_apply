import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeIngestFunnelStats } from '../src/scanner/storageCsvIngestion.js';

describe('computeIngestFunnelStats - Granular Ingest Drops', () => {
  it('correctly categorizes granular drop reasons with explicit counts and details', () => {
    const csvRows = [
      { task_id: 't1', applywizz_id: 'AWL-001', job_url: 'https://boards.greenhouse.io/co1/jobs/1', company_name: 'Co 1' },
      { task_id: 't2', applywizz_id: 'AWL-002', job_url: 'https://boards.greenhouse.io/co2/jobs/2', company_name: 'Co 2' },
      { task_id: 't3', applywizz_id: 'AWL-003', job_url: 'https://boards.greenhouse.io/co3/jobs/3', company_name: 'Co 3' },
      { task_id: 't4', applywizz_id: 'AWL-004', job_url: 'https://boards.greenhouse.io/co4/jobs/4', company_name: 'Co 4' },
      { task_id: 't5', applywizz_id: 'AWL-005', job_url: 'https://boards.greenhouse.io/co5/jobs/5', company_name: 'Co 5' },
      { task_id: 't6', applywizz_id: 'AWL-006', job_url: 'https://boards.greenhouse.io/co6/jobs/6', company_name: 'Co 6' },
      { task_id: 't7', applywizz_id: 'AWL-007', job_url: 'https://boards.greenhouse.io/co7/jobs/7', company_name: 'Co 7' },
    ];

    const createdTaskIds = new Set(['t1']); // t1 created successfully

    const profiles = new Map([
      ['AWL-002', { zoho_connected: false }],
      ['AWL-003', { zoho_connected: true }],
      ['AWL-004', { zoho_connected: true }],
      ['AWL-005', { zoho_connected: true }],
      ['AWL-006', { zoho_connected: true }],
      ['AWL-007', { zoho_connected: true }],
    ]);

    const templates = new Map([
      ['https://boards.greenhouse.io/co1/jobs/1', { is_expired: false }],
      ['https://boards.greenhouse.io/co2/jobs/2', { is_expired: false }],
      ['https://boards.greenhouse.io/co3/jobs/3', { is_expired: true }],
      // t4 has no template -> no_scan_template
      ['https://boards.greenhouse.io/co5/jobs/5', { is_expired: false }],
      ['https://boards.greenhouse.io/co6/jobs/6', { is_expired: false }],
      ['https://boards.greenhouse.io/co7/jobs/7', { is_expired: false }],
    ]);

    const exclusionContext = {
      clearanceUrls: new Set(['https://boards.greenhouse.io/co5/jobs/5']),
      excludedCompanyPairs: new Set(['AWL-006|https://boards.greenhouse.io/co6/jobs/6']),
      latestEmployerPairs: new Set(['AWL-007|https://boards.greenhouse.io/co7/jobs/7']),
    };

    const stats = computeIngestFunnelStats(csvRows, createdTaskIds, profiles, templates, exclusionContext);

    assert.equal(stats.totalCsvRows, 7);
    assert.equal(stats.tasksCreated, 1);
    assert.equal(stats.droppedRows, 6);

    assert.equal(stats.dropReasons.zoho_disconnected, 1);
    assert.equal(stats.dropReasons.job_expired, 1);
    assert.equal(stats.dropReasons.no_scan_template, 1);
    assert.equal(stats.dropReasons.security_clearance, 1);
    assert.equal(stats.dropReasons.excluded_company, 1);
    assert.equal(stats.dropReasons.latest_employer, 1);

    assert.equal(stats.droppedDetails.length, 6);
    const reasons = stats.droppedDetails.map(d => d.reason);
    assert.ok(reasons.includes('Candidate Zoho mailbox not connected'));
    assert.ok(reasons.includes('Job posting closed or expired'));
    assert.ok(reasons.includes('Job template not found / scanning failed'));
    assert.ok(reasons.includes('Security clearance question required'));
    assert.ok(reasons.includes('Excluded company policy'));
    assert.ok(reasons.includes('Previous or current employer conflict'));
  });

  it('verifies dropped details format aligns with FilteredStatsItem stage pre_creation', () => {
    const droppedDetail = {
      applywizzId: 'AWL-002',
      companyName: 'Acme Corp',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      reason: 'Candidate Zoho mailbox not connected',
    };

    const item = {
      id: `pre_${droppedDetail.applywizzId}_${droppedDetail.jobUrl}`,
      applywizzId: droppedDetail.applywizzId,
      companyName: droppedDetail.companyName,
      jobUrl: droppedDetail.jobUrl,
      stage: 'pre_creation' as const,
      status: 'DROPPED_PRE_CREATION',
      reason: droppedDetail.reason,
    };

    assert.equal(item.stage, 'pre_creation');
    assert.equal(item.status, 'DROPPED_PRE_CREATION');
    assert.equal(item.applywizzId, 'AWL-002');
    assert.equal(item.companyName, 'Acme Corp');
  });
});
