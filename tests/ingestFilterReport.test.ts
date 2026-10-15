import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { getCurrentIngestFilterReportPath, renderIngestFilterReportCsv, writeCurrentIngestFilterReport, clearCurrentIngestFilterReport } from '../src/scanner/ingestFilterReport.js';
import type { IngestFilterReport } from '../src/types/index.js';

const report: IngestFilterReport = {
  clearanceLinks: ['https://boards.greenhouse.io/clearance/jobs/1'],
  excludedCompanyApplications: [
    { applywizzId: 'AWL-1', jobUrl: 'https://boards.greenhouse.io/excluded/jobs/2' },
    { applywizzId: 'AWL-1', jobUrl: 'https://boards.greenhouse.io/both/jobs/3' },
  ],
  latestEmployerApplications: [
    { applywizzId: 'AWL-1', jobUrl: 'https://boards.greenhouse.io/both/jobs/3' },
  ],
};

afterEach(async () => clearCurrentIngestFilterReport());

describe('ingest filter report CSV', () => {
  it('renders three labeled sections with clearance links only and AWL IDs in company sections', () => {
    expect(renderIngestFilterReportCsv(report)).toBe([
      'section,awl_id,job_url',
      'clearance,,https://boards.greenhouse.io/clearance/jobs/1',
      'excluded_company,AWL-1,https://boards.greenhouse.io/excluded/jobs/2',
      'excluded_company,AWL-1,https://boards.greenhouse.io/both/jobs/3',
      'latest_employer,AWL-1,https://boards.greenhouse.io/both/jobs/3',
    ].join('\r\n') + '\r\n');
  });

  it('renders a valid header-only CSV when no applications were filtered', () => {
    expect(renderIngestFilterReportCsv({
      clearanceLinks: [],
      excludedCompanyApplications: [],
      latestEmployerApplications: [],
    })).toBe('section,awl_id,job_url\r\n');
  });

  it('escapes commas and quotes in CSV values', () => {
    expect(renderIngestFilterReportCsv({
      clearanceLinks: [],
      excludedCompanyApplications: [{
        applywizzId: 'AWL,"1',
        jobUrl: 'https://example.test/jobs/1?tag=a,b',
      }],
      latestEmployerApplications: [],
    })).toBe('section,awl_id,job_url\r\nexcluded_company,"AWL,""1","https://example.test/jobs/1?tag=a,b"\r\n');
  });

  it('writes the current report under the OS temp directory and clears only that file', async () => {
    const reportPath = await writeCurrentIngestFilterReport(report);
    expect(reportPath).toBe(getCurrentIngestFilterReportPath());
    expect(await fs.readFile(reportPath, 'utf8')).toContain('AWL-1');
    await clearCurrentIngestFilterReport();
    await expect(fs.access(reportPath)).rejects.toThrow();
  });
});
