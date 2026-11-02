import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLocationString, extractLocationSearchPrefix } from '../src/submitter/formFiller.js';

test('sanitizeLocationString strips candidate name and newline if present', () => {
  const corrupted = 'Dora Sai Ganesh Reddy Satti \nwaterbury, Connecticut, United States';
  assert.equal(sanitizeLocationString(corrupted), 'waterbury, Connecticut, United States');

  const clean = 'Austin, Texas, United States';
  assert.equal(sanitizeLocationString(clean), 'Austin, Texas, United States');

  const empty = '';
  assert.equal(sanitizeLocationString(empty), '');
});

test('extractLocationSearchPrefix extracts city name properly without candidate name', () => {
  const corrupted = 'Dora Sai Ganesh Reddy Satti \nwaterbury, Connecticut, United States';
  const prefix = extractLocationSearchPrefix(corrupted);
  assert.equal(prefix, 'waterbury');

  const standard = 'Seattle, WA, USA';
  assert.equal(extractLocationSearchPrefix(standard), 'Seattle');

  const noComma = 'Chicago';
  assert.equal(extractLocationSearchPrefix(noComma), 'Chicago');
});
