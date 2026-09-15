/**
 * PostgREST schema-cache misses on profiles writes (country was the first observed field).
 */

import { parseMissingProfilesColumnFromPostgrestError } from '../src/db/profiles.js';

const RAILWAY_ERROR =
  "Could not find the 'country' column of 'profiles' in the schema cache";

let passed = 0;
let total = 0;

function assert(condition: boolean, name: string) {
  total++;
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.error(`FAIL: ${name}`);
  }
}

assert(
  parseMissingProfilesColumnFromPostgrestError(RAILWAY_ERROR) === 'country',
  'parses live Railway country error'
);
assert(
  parseMissingProfilesColumnFromPostgrestError(
    "Could not find the 'country_code' column of 'profiles' in the schema cache"
  ) === 'country_code',
  'parses country_code'
);
assert(
  parseMissingProfilesColumnFromPostgrestError(
    "Could not find the 'resume_storage_path' column of 'profiles' in the schema cache"
  ) === 'resume_storage_path',
  'parses any profiles column name'
);
assert(
  parseMissingProfilesColumnFromPostgrestError('duplicate key value violates unique constraint') === null,
  'ignores unrelated upsert errors'
);
assert(
  parseMissingProfilesColumnFromPostgrestError(
    "Could not find the 'foo' column of 'other_table' in the schema cache"
  ) === null,
  'ignores missing-column errors on other tables'
);

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
