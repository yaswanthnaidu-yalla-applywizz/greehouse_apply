import { describe, it, expect, vi } from 'vitest';
import { resolveZohoConnectionStatuses } from '../src/services/zohoConnectionCheck.js';
import { backfillZohoConnectedProfiles } from '../src/db/sandboxClient.js';
import type { ProfileRow } from '../db/profiles.js';

describe('Zoho Connected Filter & Backfill', () => {
  const mockProfiles: ProfileRow[] = [
    {
      id: 'p1',
      applywizz_id: 'AWL-101',
      client_name: 'Candidate One',
      email: 'cand1@applywizard.ai',
      company_email: 'cand1@applywizard.ai',
      zoho_connected: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'p2',
      applywizz_id: 'AWL-102',
      client_name: 'Candidate Two',
      email: 'cand2@gmail.com',
      company_email: null,
      zoho_connected: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'p3',
      applywizz_id: 'AWL-103',
      client_name: 'Candidate Three',
      email: 'cand3@applywizard.ai',
      company_email: null,
      zoho_connected: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'p4',
      applywizz_id: 'AWL-YASWANTH',
      client_name: 'Demo Candidate',
      email: 'demo@applywizard.ai',
      company_email: 'demo@applywizard.ai',
      zoho_connected: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'p5',
      applywizz_id: 'AWL-105',
      client_name: 'Pre-flagged Candidate',
      email: 'cand5@example.com',
      company_email: 'cand5@example.com',
      zoho_connected: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  it('marks profiles connected if company_email matches connectedEmails set', () => {
    const connectedEmails = new Set(['cand1@applywizard.ai']);
    const statuses = resolveZohoConnectionStatuses(mockProfiles, connectedEmails);

    expect(statuses.get('AWL-101')).toBe(true);
    expect(statuses.get('AWL-102')).toBe(false);
  });

  it('marks profiles connected if email matches connectedEmails set even if company_email is null', () => {
    const connectedEmails = new Set(['cand3@applywizard.ai']);
    const statuses = resolveZohoConnectionStatuses(mockProfiles, connectedEmails);

    expect(statuses.get('AWL-103')).toBe(true);
    expect(statuses.get('AWL-102')).toBe(false);
  });

  it('marks demo bypass candidate AWL-YASWANTH connected regardless of connectedEmails list', () => {
    const connectedEmails = new Set(['other@applywizard.ai']);
    const statuses = resolveZohoConnectionStatuses(mockProfiles, connectedEmails);

    expect(statuses.get('AWL-YASWANTH')).toBe(true);
  });

  it('preserves pre-flagged zoho_connected = true when connectedEmails matches or when fallback is used', () => {
    const connectedEmails = new Set(['cand1@applywizard.ai']);
    const statuses = resolveZohoConnectionStatuses(mockProfiles, connectedEmails);
    expect(statuses.get('AWL-105')).toBe(true);

    const fallbackStatuses = resolveZohoConnectionStatuses(mockProfiles);
    expect(fallbackStatuses.get('AWL-105')).toBe(true);
    expect(fallbackStatuses.get('AWL-101')).toBe(false);
  });

  it('backfills zoho_connected profiles in PostgreSQL from the REST API', async () => {
    const originalFetch = globalThis.fetch;
    const queries: { sql: string; values?: any[] }[] = [];

    const mockPool = {
      query: vi.fn(async (sql: string, values?: any[]) => {
        queries.push({ sql, values });
        if (sql.includes('UPDATE profiles') && sql.includes('zoho_connected = true')) {
          return { rowCount: 5 };
        }
        return { rowCount: 0 };
      }),
    } as any;

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          users: [
            { email: 'user1@applywizard.ai', connected: true },
            { email: 'user2@applywizard.ai', connected: false },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    try {
      const count = await backfillZohoConnectedProfiles(mockPool);
      expect(count).toBe(5);
      expect(queries.some((q) => q.sql.includes('UPDATE profiles SET zoho_connected = false'))).toBe(true);
      expect(queries.some((q) => q.sql.includes('UPDATE profiles \n         SET zoho_connected = true'))).toBe(true);
      const updateQuery = queries.find((q) => q.sql.includes('UPDATE profiles \n         SET zoho_connected = true'));
      expect(updateQuery?.values?.[0]).toContain('user1@applywizard.ai');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aggregates connected emails from both Zoho and Gmail user endpoints', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('/api/zoho/ui/users')) {
        return new Response(
          JSON.stringify({
            users: [
              { email: 'zoho.user@applywizard.ai', connected: true },
              { email: 'unconnected.zoho@applywizard.ai', connected: false },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/gmail/ui/users')) {
        return new Response(
          JSON.stringify({
            total: 2,
            connectedCount: 1,
            users: [
              { email: 'gmail.user@applywizard.ai', connected: true },
              { email: 'unconnected.gmail@applywizard.ai', connected: false },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    try {
      const { fetchConnectedEmails } = await import('../src/services/zohoConnectionCheck.js');
      const emails = await fetchConnectedEmails('https://zoho-mail-reader.onrender.com');
      expect(emails.has('zoho.user@applywizard.ai')).toBe(true);
      expect(emails.has('gmail.user@applywizard.ai')).toBe(true);
      expect(emails.has('unconnected.zoho@applywizard.ai')).toBe(false);
      expect(emails.has('unconnected.gmail@applywizard.ai')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

