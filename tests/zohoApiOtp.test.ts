import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractOtpCodeFromText } from '../src/services/zoho-connector.js';

describe('extractOtpCodeFromText', () => {
  it('extracts Greenhouse copy-paste format from body', () => {
    const text = `
      Hi Sri,
      Please complete your application for DoorDash.
      Copy and paste this code into the security code field on your application: NgW4NT62
      Thanks!
    `;
    const code = extractOtpCodeFromText(text);
    assert.equal(code, 'NgW4NT62');
  });

  it('extracts labeled verification code from text', () => {
    const text = 'Your verification code is: 938104. Please enter it within 10 minutes.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, '938104');
  });

  it('extracts 8-character alphanumeric code with letters and digits', () => {
    const text = 'Here is your security code: Aebf0aDc to continue applying.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, 'Aebf0aDc');
  });

  it('extracts 6-digit numeric OTP code', () => {
    const text = 'Enter the following code to verify your account: 629103';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, '629103');
  });

  it('returns null on non-OTP text or stopwords', () => {
    const text = 'Thank you for your application to DoorDash. We have received your response.';
    const code = extractOtpCodeFromText(text);
    assert.equal(code, null);
  });
});
