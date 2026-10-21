import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OTP_EMAIL_CLOCK_SKEW_MS,
  parseZohoReceivedTimestamp,
  extractOtpCodeFromText,
  isMessageEligibleByTimestamp,
} from '../src/services/inbox/inboxPoller.js';

describe('Inbox Strategies & Poller (PR 8)', () => {
  it('enforces 5,000ms clock skew constant (Remedy 8A)', () => {
    assert.equal(OTP_EMAIL_CLOCK_SKEW_MS, 5000);
  });

  it('correctly handles millisecond and second timestamps in parseZohoReceivedTimestamp', () => {
    const epochSec = 1710000000;
    const epochMs = epochSec * 1000;

    assert.equal(parseZohoReceivedTimestamp(epochSec), epochMs);
    assert.equal(parseZohoReceivedTimestamp(epochMs), epochMs);
    assert.equal(parseZohoReceivedTimestamp(String(epochSec)), epochMs);
    assert.equal(parseZohoReceivedTimestamp('invalid-date'), null);
  });

  it('determines message eligibility respecting clock skew', () => {
    const submitTime = 100_000;
    const skew = OTP_EMAIL_CLOCK_SKEW_MS; // 5000

    // Message arrived 4s before submit -> eligible due to skew
    assert.equal(isMessageEligibleByTimestamp(submitTime - 4000, submitTime), true);
    // Message arrived 6s before submit -> ineligible
    assert.equal(isMessageEligibleByTimestamp(submitTime - 6000, submitTime), false);
  });

  it('extracts OTP code cleanly across whitespace and HTML', () => {
    const sample = 'Your code is: <b>Ab39Kx01</b>';
    assert.equal(extractOtpCodeFromText(sample), 'Ab39Kx01');
  });
});
