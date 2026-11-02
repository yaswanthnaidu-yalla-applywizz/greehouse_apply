import test from 'node:test';
import assert from 'node:assert/strict';
import { isConsentOrPrivacyPolicyField } from '../src/submitter/formFiller.js';

test('isConsentOrPrivacyPolicyField identifies candidate consent and privacy policy questions', () => {
  assert.equal(isConsentOrPrivacyPolicyField("Please review and acknowledge Cloudflare's Candidate Privacy Policy"), true);
  assert.equal(isConsentOrPrivacyPolicyField("ELECTRONIC RECORD AND SIGNATURE DISCLOSURE"), true);
  assert.equal(isConsentOrPrivacyPolicyField("Privacy Notice"), true);
  assert.equal(isConsentOrPrivacyPolicyField("Consent to process personal data"), true);
  assert.equal(isConsentOrPrivacyPolicyField("Terms and Conditions agreement"), true);
  assert.equal(isConsentOrPrivacyPolicyField("Are you willing to relocate?"), false);
  assert.equal(isConsentOrPrivacyPolicyField("What is your desired salary?"), false);
});
