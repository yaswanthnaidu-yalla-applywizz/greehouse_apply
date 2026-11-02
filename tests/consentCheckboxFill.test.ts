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

test('isConsentOrPrivacyPolicyField identifies demographic survey consent without company names', () => {
  assert.equal(
    isConsentOrPrivacyPolicyField(
      'By checking this box, I consent to the company collecting, storing, and processing my responses to the demographic data surveys above.'
    ),
    true
  );
  assert.equal(
    isConsentOrPrivacyPolicyField(
      'By checking this box, I consent to the employer collecting, storing, and processing my responses to the demographic data surveys above.'
    ),
    true
  );
  assert.equal(
    isConsentOrPrivacyPolicyField('I consent to the collection and processing of demographic data'),
    true
  );
  assert.equal(
    isConsentOrPrivacyPolicyField('Demographic survey processing consent'),
    true
  );
  // SMS/marketing should be false even if consent appears in label
  assert.equal(
    isConsentOrPrivacyPolicyField('I consent to receiving text messages and marketing updates'),
    false
  );
  // Standard demographic questions should not be classified as consent checkboxes
  assert.equal(
    isConsentOrPrivacyPolicyField('What is your gender identity?'),
    false
  );
});
