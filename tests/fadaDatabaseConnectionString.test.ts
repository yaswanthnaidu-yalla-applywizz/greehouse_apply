import assert from 'node:assert/strict';
import { getFadaDatabaseConnectionString } from '../src/utils/fadaDatabaseConnectionString.ts';

assert.equal(
  getFadaDatabaseConnectionString({
    DB2_URL: 'db2-value',
    DATABASE_URL_2: 'database-url-2-value',
    DATABASE_URL: 'database-url-value',
  }),
  'db2-value',
);
assert.equal(
  getFadaDatabaseConnectionString({
    DATABASE_URL_2: 'database-url-2-value',
    DATABASE_URL: 'database-url-value',
  }),
  'database-url-2-value',
);
assert.equal(
  getFadaDatabaseConnectionString({ DATABASE_URL: 'database-url-value' }),
  'database-url-value',
);

assert.throws(
  () => getFadaDatabaseConnectionString({}),
  (error: unknown) => {
    assert.equal((error as Error).message, 'FADA requires DB2_URL, DATABASE_URL_2, or DATABASE_URL to be configured.');
    assert.doesNotMatch((error as Error).message, /db2-value|database-url/i);
    return true;
  },
);

console.log('FADA database connection string checks passed');
