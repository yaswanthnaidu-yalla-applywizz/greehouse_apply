import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolveZohoConnectionStatuses } from '../src/services/zohoConnectionCheck.js';
import type { ProfileRow } from '../src/db/profiles.js';

describe('resolveZohoConnectionStatuses', () => {
  it('matches company emails case-insensitively and treats missing emails as disconnected', () => {
    const profiles: ProfileRow[] = [
      {
        applywizz_id: 'awl-connected',
        client_name: 'Connected Candidate',
        company_email: 'candidate@applywizz.ai',
        zoho_connected: false,
      },
      {
        applywizz_id: 'AWL-DISCONNECTED',
        client_name: 'Disconnected Candidate',
        company_email: 'other@applywizz.ai',
        zoho_connected: true,
      },
      {
        applywizz_id: 'AWL-NO-EMAIL',
        client_name: 'No Email Candidate',
      },
    ];

    const statuses = resolveZohoConnectionStatuses(
      profiles,
      new Set(['CANDIDATE@APPLYWIZZ.AI'])
    );

    deepStrictEqual(
      Array.from(statuses.entries()),
      [
        ['AWL-CONNECTED', true],
        ['AWL-DISCONNECTED', false],
        ['AWL-NO-EMAIL', false],
      ]
    );
  });

  it('uses stored true flags on connector failure and treats null or false as disconnected', () => {
    const profiles: ProfileRow[] = [
      { applywizz_id: 'AWL-TRUE', client_name: 'Stored True', zoho_connected: true },
      { applywizz_id: 'AWL-FALSE', client_name: 'Stored False', zoho_connected: false },
      { applywizz_id: 'AWL-NULL', client_name: 'Stored Null', zoho_connected: undefined },
    ];

    const statuses = resolveZohoConnectionStatuses(profiles);

    strictEqual(statuses.get('AWL-TRUE'), true);
    strictEqual(statuses.get('AWL-FALSE'), false);
    strictEqual(statuses.get('AWL-NULL'), false);
  });
});
