import { describe, it, expect } from 'vitest';
import { computeIngestFunnelStats } from '../../src/scanner/storageCsvIngestion.js';

describe('computeIngestFunnelStats', () => {
  it('correctly categorizes drop reasons between CSV rows and created applications', () => {
    const csvRows = [
      { task_id: 't1', applywizz_id: 'AWL-1', job_url: 'https://grnh.se/1', company_name: 'Alpha' },
      { task_id: 't2', applywizz_id: 'AWL-2', job_url: 'https://grnh.se/2', company_name: 'Beta' },
      { task_id: 't3', applywizz_id: 'AWL-3', job_url: 'https://grnh.se/3', company_name: 'Gamma' },
      { task_id: 't4', applywizz_id: 'AWL-4', job_url: 'https://grnh.se/4', company_name: 'Delta' },
    ];
    const createdTaskIds = new Set(['t1']);
    const profiles = new Map<string, any>([
      ['AWL-1', { zoho_connected: true }],
      ['AWL-2', { zoho_connected: false }],
      ['AWL-3', { zoho_connected: true }],
      ['AWL-4', { zoho_connected: true }],
    ]);
    const templates = new Map<string, any>([
      ['https://grnh.se/3', { is_expired: true }],
    ]);

    const stats = computeIngestFunnelStats(csvRows, createdTaskIds, profiles, templates);
    expect(stats.totalCsvRows).toBe(4);
    expect(stats.tasksCreated).toBe(1);
    expect(stats.droppedRows).toBe(3);
    expect(stats.dropReasons.zoho_disconnected).toBe(1);
    expect(stats.dropReasons.job_expired).toBe(1);
    expect(stats.dropReasons.no_scan_template).toBe(1);
  });
});
