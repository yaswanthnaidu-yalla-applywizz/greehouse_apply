import test from 'node:test';
import assert from 'node:assert/strict';
import { isReferralSourceQuestion, pickReferralOptionText } from '../src/submitter/formFiller.js';

test('isReferralSourceQuestion detects referral and job discovery questions', () => {
  assert.equal(isReferralSourceQuestion('How did you hear about this job?'), true);
  assert.equal(isReferralSourceQuestion('Where did you hear about us?'), true);
  assert.equal(isReferralSourceQuestion('Referral Source'), true);
  assert.equal(isReferralSourceQuestion('Are you legally authorized to work in the US?'), false);
});

test('pickReferralOptionText prioritizes LinkedIn, then Website, then first option', () => {
  const withLinkedIn = ['Campus Recruiting', 'Employee Referral', 'Indeed', 'LinkedIn', 'Other'];
  assert.equal(pickReferralOptionText(withLinkedIn), 'LinkedIn');

  const withWebsite = ['Campus Recruiting', 'Company Website', 'Other'];
  assert.equal(pickReferralOptionText(withWebsite), 'Company Website');

  const general = ['Option A', 'Option B'];
  assert.equal(pickReferralOptionText(general), 'Option A');
});
