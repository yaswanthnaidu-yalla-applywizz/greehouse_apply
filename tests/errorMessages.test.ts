import { describe, it, expect } from 'vitest';
import { normalizeOperatorErrorMessage, OperatorErrors } from '../src/operator/operatorErrorMessages.js';
import { sanitizeFailureCause } from '../src/submitter/proofCapture.js';

describe('Phase 5: Error Messages & Contextual Failure Filenames', () => {
  it('maps ZOHO_INBOX_UNAVAILABLE OTP timeout to OTP-specific message, not Network error', () => {
    const raw = '[OTP_FETCH:TIMEOUT] Automatic OTP retrieval timed out after 300s reason=ZOHO_INBOX_UNAVAILABLE';
    const message = normalizeOperatorErrorMessage(raw);
    expect(message).toBe(
      'OTP verification code not received within the allowed window. Application will be retried automatically.'
    );
    expect(message).not.toBe(OperatorErrors.NETWORK);
  });

  it('maps GMAIL_OTP_NOT_FOUND to Gmail-specific message', () => {
    const raw = '[OTP_FETCH:TIMEOUT] Automatic OTP retrieval timed out after 300s reason=GMAIL_OTP_NOT_FOUND';
    const message = normalizeOperatorErrorMessage(raw);
    expect(message).toBe('Gmail security code not found. Check that the mailbox is connected on Render.');
    expect(message).not.toBe(OperatorErrors.NETWORK);
  });

  it('maps POLL_BUDGET_EXHAUSTED to OTP-specific message', () => {
    const raw = '[OTP_FETCH:POLL_BUDGET_EXHAUSTED] Automatic OTP retrieval timed out after 300s';
    const message = normalizeOperatorErrorMessage(raw);
    expect(message).toBe(
      'OTP verification code not received within the allowed window. Application will be retried automatically.'
    );
    expect(message).not.toBe(OperatorErrors.NETWORK);
  });

  it('maps mailbox_not_connected to candidate Gmail mailbox not connected message', () => {
    const raw = 'mailbox_not_connected: OAuth not configured for candidate';
    const message = normalizeOperatorErrorMessage(raw);
    expect(message).toBe(
      'Candidate Gmail mailbox is not connected. Set up OAuth on Render for this account.'
    );
    expect(message).not.toBe(OperatorErrors.NETWORK);
  });

  it('preserves generic network error handling for ECONNREFUSED', () => {
    const raw = 'connect ECONNREFUSED 127.0.0.1:443';
    const message = normalizeOperatorErrorMessage(raw);
    expect(message).toBe(OperatorErrors.NETWORK);
  });

  it('sanitizes failure cause for required_field_Are you authorized to work? under 60 chars', () => {
    const sanitized = sanitizeFailureCause('required_field_Are you authorized to work?');
    expect(sanitized).toBe('required_field_are_you_authorized_to_wor');
    expect(sanitized.length).toBeLessThanOrEqual(40);
    expect(sanitized).not.toContain('?');
    expect(sanitized).not.toContain(' ');
  });

  it('generates filename with application ID prefix and sanitized cause under 60 chars total', () => {
    const appId = 'app1';
    const cause = 'required_field_Are you authorized to work?';
    const sanitized = sanitizeFailureCause(cause);
    const filename = `${appId}_failed_${sanitized}.png`;

    expect(filename).toContain(appId);
    expect(filename.startsWith('app1_failed_')).toBe(true);
    expect(filename.length).toBeLessThanOrEqual(60);
  });
});
