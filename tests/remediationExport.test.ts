import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FORCE_MEMORY_DB = 'true';

import {
  buildRemediationCsv,
  extractRemediationRowsFromApp,
  handleRemediationExport,
  type RemediationExportRow,
} from '../src/server/remediationReport.js';
import type { ApplicationRow } from '../src/db/applications/types.js';
import { memoryApplications } from '../src/db/applications/memoryStore.js';

test('buildRemediationCsv builds valid RFC 4180 CSV with quotes and escapes', () => {
  const rows: RemediationExportRow[] = [
    {
      applicationId: 'app-001',
      applywizzId: 'AWL-101',
      companyName: 'Acme, Inc.',
      jobTitle: 'Senior "Full Stack" Engineer',
      ats: 'greenhouse',
      applicationStatus: 'APPLIED',
      fieldLabel: 'Work Authorization',
      controlType: 'select',
      outcome: 'resolved',
      issueFaced: 'Automation left required dropdown unselected;\r\noptions had specific phrasing.',
      issueFixed: 'Selected "US Citizen" based on profile facts.',
      remediatedValue: 'US Citizen',
      attemptedAt: '2026-11-18T10:00:00.000Z',
      jobUrl: 'https://boards.greenhouse.io/acme/123',
    },
  ];

  const csv = buildRemediationCsv(rows);
  assert.ok(csv.includes('Application ID,ApplyWizz ID,Company,Job Title'));
  assert.ok(csv.includes('"Acme, Inc."'));
  assert.ok(csv.includes('"Senior ""Full Stack"" Engineer"'));
  assert.ok(csv.includes('"Automation left required dropdown unselected;\r\noptions had specific phrasing."'));
  assert.ok(csv.includes('"Selected ""US Citizen"" based on profile facts."'));
});

test('extractRemediationRowsFromApp extracts from error_details.remediationReport', () => {
  const app: ApplicationRow = {
    id: 'app-test-999',
    applywizz_id: 'AWL-999',
    company_name: 'Glean',
    job_title: 'Software Engineer',
    job_url: 'https://boards.greenhouse.io/glean/jobs/1234',
    status: 'APPLIED',
    resolved_fields: [],
    error_details: {
      remediationReport: {
        timestamp: '2026-11-18T12:00:00.000Z',
        attemptedCount: 2,
        resolvedCount: 1,
        failedCount: 1,
        items: [
          {
            fieldId: 'auth_status',
            label: 'Are you authorized to work in the US?',
            controlType: 'select',
            status: 'resolved',
            issueFaced: 'Automation unselected on page',
            issueFixed: 'Committed Yes based on citizen status',
            value: 'Yes',
            attemptedAt: '2026-11-18T12:00:01.000Z',
          },
          {
            fieldId: 'referral_code',
            label: 'Internal Referral Code',
            controlType: 'text',
            status: 'failed_closed',
            issueFaced: 'Automation left required text empty',
            issueFixed: 'Failed closed: candidate has no referral code',
            value: null,
            attemptedAt: '2026-11-18T12:00:02.000Z',
          },
        ],
      },
    },
  } as any;

  const allRows = extractRemediationRowsFromApp(app, 'all');
  assert.equal(allRows.length, 2);
  assert.equal(allRows[0].outcome, 'resolved');
  assert.equal(allRows[0].fieldLabel, 'Are you authorized to work in the US?');
  assert.equal(allRows[0].remediatedValue, 'Yes');
  assert.equal(allRows[1].outcome, 'failed_closed');
  assert.equal(allRows[1].fieldLabel, 'Internal Referral Code');

  // Filter only resolved
  const resolvedOnly = extractRemediationRowsFromApp(app, 'resolved');
  assert.equal(resolvedOnly.length, 1);
  assert.equal(resolvedOnly[0].outcome, 'resolved');

  // Filter only failed_closed
  const failedOnly = extractRemediationRowsFromApp(app, 'failed_closed');
  assert.equal(failedOnly.length, 1);
  assert.equal(failedOnly[0].outcome, 'failed_closed');
});

test('handleRemediationExport returns CSV stream with headers', async () => {
  memoryApplications.clear();
  const testApp: ApplicationRow = {
    id: 'app-mem-01',
    applywizz_id: 'AWL-MEM-01',
    company_name: 'Test Corp',
    job_title: 'Backend Dev',
    job_url: 'https://jobs.ashbyhq.com/testcorp/123',
    ats: 'ashby',
    status: 'APPLIED',
    resolved_fields: [
      {
        fieldId: 'visa_sponsorship',
        name: 'visa_sponsorship',
        type: 'radio',
        label: 'Do you require visa sponsorship?',
        value: 'No',
        source: 'ai' as any,
        resolvedByTier: 5,
        confidence: 0.95,
        remediation: {
          issueFaced: 'Automation missed custom radio buttons',
          issueFixed: 'Selected No',
          status: 'resolved',
          attemptedAt: '2026-11-18T15:00:00.000Z',
          controlType: 'radio',
        },
      },
    ],
  } as any;
  memoryApplications.set('app-mem-01', testApp);

  let capturedStatus = 0;
  const capturedHeaders: Record<string, string> = {};
  let sentBody = '';

  const mockReq: any = {
    query: {
      format: 'csv',
    },
  };

  const mockRes: any = {
    setHeader(key: string, val: string) {
      capturedHeaders[key] = val;
      return this;
    },
    status(code: number) {
      capturedStatus = code;
      return this;
    },
    send(body: string) {
      sentBody = body;
      return this;
    },
    json(obj: any) {
      sentBody = JSON.stringify(obj);
      return this;
    },
  };

  await handleRemediationExport(mockReq, mockRes);

  assert.equal(capturedStatus, 200);
  assert.equal(capturedHeaders['Content-Type'], 'text/csv; charset=utf-8');
  assert.ok(capturedHeaders['Content-Disposition'].includes('attachment; filename="remediation-incidents-'));
  assert.ok(sentBody.includes('Application ID,ApplyWizz ID'));
  assert.ok(sentBody.includes('Do you require visa sponsorship?'));
  assert.ok(sentBody.includes('Automation missed custom radio buttons'));
});

test('handleRemediationExport supports format=json', async () => {
  const mockReq: any = {
    query: {
      format: 'json',
    },
  };

  let jsonResult: any = null;
  const mockRes: any = {
    setHeader() { return this; },
    status(code: number) { return this; },
    json(obj: any) {
      jsonResult = obj;
      return this;
    },
  };

  await handleRemediationExport(mockReq, mockRes);

  assert.ok(jsonResult);
  assert.equal(typeof jsonResult.total, 'number');
  assert.ok(Array.isArray(jsonResult.rows));
  assert.ok(jsonResult.rows.length >= 1);
  assert.equal(jsonResult.rows[0].fieldLabel, 'Do you require visa sponsorship?');
});
