import assert from 'node:assert/strict';
import { getPersistedRequiredness } from '../src/utils/fadaFieldRequiredness.ts';

assert.equal(getPersistedRequiredness({ isRequired: true }), true);
assert.equal(getPersistedRequiredness({ required: true }), true);
assert.equal(getPersistedRequiredness({ isRequired: false, required: true }), false);
assert.equal(getPersistedRequiredness({}), false);

console.log('fadaRequiredness compatibility checks passed');
