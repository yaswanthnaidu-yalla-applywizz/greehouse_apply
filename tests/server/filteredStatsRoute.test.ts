import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { devDashboardRouter } from '../../src/server/routes/devDashboard.js';
import { extractSlimFieldDiagnostics } from '../../src/server/filteredStats.js';

describe('extractSlimFieldDiagnostics', () => {
  it('correctly categorizes unresolved and Tier-5 AI fields with PII masking and truncation', () => {
    const mockFields = [
      { label: 'Full Name', type: 'text', source: 'resume_parse', isRequired: true, value: 'John Doe' },
      { label: 'Years of Experience', type: 'text', source: 'unresolved', isRequired: true, value: null },
      { label: 'Work Authorization', type: 'text', source: '', isRequired: true, value: '' },
      { label: 'Why do you want to join us?', type: 'textarea', source: 'ai', confidence: 0.75, value: 'I have a strong passion for solving scalable infrastructure problems.' },
      { label: 'Expected Salary / Compensation', type: 'text', source: 'ai', confidence: 0.7, value: '$150,000 / year' },
    ];

    const result = extractSlimFieldDiagnostics(mockFields);

    expect(result.totalUnresolved).toBe(2);
    expect(result.unresolvedFields.length).toBe(2);
    expect(result.unresolvedFields[0].label).toBe('Years of Experience');
    expect(result.unresolvedFields[1].label).toBe('Work Authorization');

    expect(result.totalAi).toBe(2);
    expect(result.aiFields.length).toBe(2);
    expect(result.aiFields[0].label).toBe('Why do you want to join us?');
    expect(result.aiFields[0].confidence).toBe(0.75);

    // Verify PII redaction for salary question
    expect(result.aiFields[1].label).toBe('Expected Salary / Compensation');
    expect(result.aiFields[1].valueSnippet).toBe('[CONFIDENTIAL / REDACTED]');
  });
});

describe('GET /api/dev/filtered-stats', () => {
  it('returns structured filtered stats for today', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/dev', devDashboardRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dev/filtered-stats?range=day`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toHaveProperty('hasIngestData');
      expect(body).toHaveProperty('topFunnel');
      expect(body).toHaveProperty('bottomFunnel');
      expect(Array.isArray(body.items)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);
});
