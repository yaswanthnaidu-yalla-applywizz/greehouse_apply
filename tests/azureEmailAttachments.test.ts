import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../src/config/env.js', () => ({
  config: {
    ACTIVE_AZURE_TENANT_ID: 'tenant',
    AZURE_CLIENT_ID: 'client',
    AZURE_CLIENT_SECRET: 'secret',
    AZURE_SENDER_EMAIL: 'sender@example.com',
    MS_LOGIN_BASE_URL: 'https://login.example.com',
    MS_GRAPH_BASE_URL: 'https://graph.example.com',
  },
}));

import { sendEmail } from '../src/services/azureEmail.js';

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('Azure email CSV attachments', () => {
  it('sends a CSV as a Microsoft Graph file attachment', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmail({
      to: 'yaswanthnaiduyalla@applywizz.ai',
      subject: 'Ingest report',
      text: 'Attached report',
      attachments: [{
        name: 'ingest-filter-report.csv',
        contentType: 'text/csv',
        contentBytes: Buffer.from('section,awl_id,job_url\r\n').toString('base64'),
      }],
    });

    expect(result.success).toBe(true);
    const request = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(request.message.attachments).toEqual([{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'ingest-filter-report.csv',
      contentType: 'text/csv',
      contentBytes: Buffer.from('section,awl_id,job_url\r\n').toString('base64'),
    }]);
  });
});
