import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissCookieBannersIfPresent } from '../src/submitter/liveSubmit.js';

test('dismissCookieBannersIfPresent exists as an exported function', () => {
  assert.equal(typeof dismissCookieBannersIfPresent, 'function');
});
