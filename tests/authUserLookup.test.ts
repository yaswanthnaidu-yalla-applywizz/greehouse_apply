import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { User } from '@supabase/supabase-js';
import { findAuthUserByEmailWithPager } from '../src/server/authUserLookup.js';

function fakeUser(email: string, id = 'uuid'): User {
  return { id, email, app_metadata: {}, user_metadata: {}, aud: 'authenticated' } as User;
}

describe('findAuthUserByEmailWithPager', () => {
  it('finds a user on the second page when the first page is full', async () => {
    const target = 'operator51@applywizz.ai';
    const listPage = async (page: number, perPage: number) => {
      if (page === 1) {
        const users = Array.from({ length: perPage }, (_, i) =>
          fakeUser(`user${i}@applywizz.ai`, `id-${i}`)
        );
        return { users, error: null };
      }
      if (page === 2) {
        return { users: [fakeUser(target, 'target-id')], error: null };
      }
      return { users: [], error: null };
    };

    const { user, error } = await findAuthUserByEmailWithPager(target, listPage);
    assert.equal(error, null);
    assert.ok(user);
    assert.equal(user?.email, target);
    assert.equal(user?.id, 'target-id');
  });

  it('returns null when email is absent from all pages', async () => {
    const listPage = async (page: number) => {
      if (page === 1) {
        return { users: [fakeUser('other@applywizz.ai')], error: null };
      }
      return { users: [], error: null };
    };

    const { user, error } = await findAuthUserByEmailWithPager('missing@applywizz.ai', listPage);
    assert.equal(error, null);
    assert.equal(user, null);
  });

  it('propagates listUsers errors', async () => {
    const { user, error } = await findAuthUserByEmailWithPager('x@y.com', async () => ({
      users: [],
      error: { message: 'rate limited' },
    }));
    assert.equal(user, null);
    assert.deepEqual(error, { message: 'rate limited' });
  });
});
