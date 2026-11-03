import { describe, it, expect } from 'vitest';
import { saveIngestFunnelStats, getIngestFunnelStats } from '../../src/db/funnelStats.js';

describe('funnelStats storage in system_config', () => {
  it('saves and retrieves funnel stats for a date', async () => {
    const testDate = '2026-11-03';
    const stats = {
      totalCsvRows: 1482,
      tasksCreated: 758,
      droppedRows: 724,
      dropReasons: {
        zoho_disconnected: 522,
        job_expired: 146,
        no_scan_template: 50,
        already_applied: 3,
        exclusions_or_other: 3,
      },
      droppedDetails: [
        {
          applywizzId: 'AWL-39785',
          companyName: 'Precisely',
          jobUrl: 'https://grnh.se/5pmzmns95us',
          reason: 'job_expired',
        },
      ],
    };

    const saved = await saveIngestFunnelStats(testDate, stats);
    expect(saved).toBe(true);

    const fetched = await getIngestFunnelStats(testDate);
    expect(fetched).not.toBeNull();
    expect(fetched?.totalCsvRows).toBe(1482);
    expect(fetched?.tasksCreated).toBe(758);
    expect(fetched?.droppedRows).toBe(724);
    expect(fetched?.dropReasons.zoho_disconnected).toBe(522);
  });
});
