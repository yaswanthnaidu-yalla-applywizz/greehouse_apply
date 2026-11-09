import assert from 'node:assert/strict';
import { getFadaDatabaseConnectionString } from '../.agents/skills/fada/scripts/fada-config.ts';
import { getPersistedRequiredness } from '../.agents/skills/fada/scripts/fada-field-requiredness.ts';

assert.equal(getPersistedRequiredness({ isRequired: true }), true);
assert.equal(getPersistedRequiredness({ required: true }), true);
assert.equal(getPersistedRequiredness({ isRequired: false, required: true }), false);
assert.equal(getPersistedRequiredness({}), false);
assert.throws(() => getFadaDatabaseConnectionString({}), /DB2_URL, DATABASE_URL_2, or DATABASE_URL/);
assert.equal(getFadaDatabaseConnectionString({ DB2_URL: 'first', DATABASE_URL_2: 'second' }), 'first');
assert.equal(getFadaDatabaseConnectionString({ DATABASE_URL_2: 'second', DATABASE_URL: 'third' }), 'second');
assert.equal(getFadaDatabaseConnectionString({ DATABASE_URL: 'third' }), 'third');

console.log('fadaRequiredness compatibility checks passed');
