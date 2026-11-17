import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { invalidateResumeParseCache } from '../src/resolver/tier2ResumeParse.js';
import { setDbClient } from '../src/db/client.js';

describe('tier2ResumeParse - invalidateResumeParseCache', () => {
  it('returns 0 immediately if applywizzIds array is empty', async () => {
    const cleared = await invalidateResumeParseCache([]);
    assert.equal(cleared, 0);
  });

  it('updates profiles resume_text and resume_facts to null for candidate IDs', async () => {
    let updatedPayload: any = null;
    let targetIds: string[] = [];

    const mockDb = {
      from: (table: string) => {
        if (table === 'profiles') {
          return {
            update: (payload: any) => {
              updatedPayload = payload;
              return {
                in: (column: string, ids: string[]) => {
                  assert.equal(column, 'applywizz_id');
                  targetIds = ids;
                  return Promise.resolve({ error: null, count: ids.length });
                },
              };
            },
          };
        }
        if (table === 'candidate_resume_parsed') {
          return {
            delete: () => ({
              in: () => Promise.resolve({ error: null }),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    setDbClient(mockDb as any);

    const cleared = await invalidateResumeParseCache(['AWL-111', 'AWL-222']);
    assert.equal(cleared, 2);
    assert.deepEqual(targetIds, ['AWL-111', 'AWL-222']);
    assert.equal(updatedPayload.resume_text, null);
    assert.equal(updatedPayload.resume_facts, null);
  });
});
