import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IngestFilterReport } from '../types/index.js';

const CURRENT_REPORT_PATH = path.join(os.tmpdir(), 'applywizz-current-ingest-filter-report.csv');

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function renderIngestFilterReportCsv(report: IngestFilterReport): string {
  const rows = [['section', 'awl_id', 'job_url']];
  rows.push(...report.clearanceLinks.map((jobUrl) => ['clearance', '', jobUrl]));
  rows.push(...report.excludedCompanyApplications.map(({ applywizzId, jobUrl }) => [
    'excluded_company',
    applywizzId,
    jobUrl,
  ]));
  rows.push(...report.latestEmployerApplications.map(({ applywizzId, jobUrl }) => [
    'latest_employer',
    applywizzId,
    jobUrl,
  ]));
  if (Array.isArray(report.filteredOutApplications)) {
    rows.push(...report.filteredOutApplications.map(({ applywizzId, jobUrl }) => [
      'filtered_out',
      applywizzId,
      jobUrl,
    ]));
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export async function writeCurrentIngestFilterReport(report: IngestFilterReport): Promise<string> {
  await fs.writeFile(CURRENT_REPORT_PATH, renderIngestFilterReportCsv(report), 'utf8');
  return CURRENT_REPORT_PATH;
}

export async function clearCurrentIngestFilterReport(): Promise<void> {
  try {
    await fs.unlink(CURRENT_REPORT_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function getCurrentIngestFilterReportPath(): string {
  return CURRENT_REPORT_PATH;
}
