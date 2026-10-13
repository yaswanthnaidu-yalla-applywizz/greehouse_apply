import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePhoneNumberForSubmission } from '../src/submitter/formFiller.js';

describe('Phone Number Formatting', () => {
  it('strips +1 prefix from 11-digit US phone numbers', () => {
    const formatted = sanitizePhoneNumberForSubmission('+1 (555) 234-5678');
    assert.equal(formatted, '(555) 234-5678');
  });

  it('strips leading 1 from 11-digit US phone numbers', () => {
    const formatted = sanitizePhoneNumberForSubmission('15552345678');
    assert.equal(formatted, '5552345678');
  });

  it('does NOT strip leading digits from 10-digit international phone numbers starting with 1', () => {
    // 10 digits total: stripping '1' leaves 9 digits, causing "Phone number is too short"
    const formatted = sanitizePhoneNumberForSubmission('1414217529');
    assert.equal(formatted, '1414217529');
  });

  it('preserves 10-digit international phone numbers', () => {
    const formatted = sanitizePhoneNumberForSubmission('8749249111');
    assert.equal(formatted, '8749249111');
  });
});
