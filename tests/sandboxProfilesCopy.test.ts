import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyProfilesFromDb2 } from '../src/db/sandboxClient.js';
import { SANDBOX_CA_EMAIL } from '../src/db/sandboxAssignment.js';

test('copyProfilesFromDb2 function contract and parameter signature', () => {
  assert.equal(typeof copyProfilesFromDb2, 'function');
  assert.equal(copyProfilesFromDb2.length >= 1, true);
  assert.equal(typeof SANDBOX_CA_EMAIL, 'string');
  assert.equal(SANDBOX_CA_EMAIL, 'yaswanthnaiduyalla@applywizz.ai');
});

test('copyProfilesFromDb2 throws error when DB2_DATABASE_URL is missing', async () => {
  const orig = process.env.DB2_DATABASE_URL;
  try {
    delete process.env.DB2_DATABASE_URL;
    await assert.rejects(
      async () => {
        await copyProfilesFromDb2({} as any);
      },
      /DB2_DATABASE_URL is not set/
    );
  } finally {
    if (orig) process.env.DB2_DATABASE_URL = orig;
  }
});
