import test from 'node:test';
import assert from 'node:assert/strict';
import { getGreenhouseSubmitButtonSelectors } from '../src/submitter/liveSubmit.js';

test('getGreenhouseSubmitButtonSelectors prioritizes Greenhouse application form submit buttons', () => {
  const selectors = getGreenhouseSubmitButtonSelectors();
  assert.equal(selectors[0], '#submit_app');
  assert.ok(selectors.some((s) => s.includes('#application_form')));
  const submitAppIdx = selectors.indexOf('#submit_app');
  const genericBtnIdx = selectors.findIndex((s) => s.startsWith('button[type="submit"]'));
  assert.ok(submitAppIdx < genericBtnIdx, 'expected #submit_app to precede generic button[type="submit"]');
  assert.ok(selectors.some((s) => s.includes(':not(footer button)')), 'expected newsletter/footer exclusion');
});
