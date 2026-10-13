import { describe, expect, it } from 'vitest';
import { getRetryReason, isAutomaticRetryAllowed } from '../src/submitter/submissionRetry.js';

describe('automatic submission retry eligibility', () => {
  it('allows only the explicitly safe browser launch failure', () => {
    expect(isAutomaticRetryAllowed('BROWSER_LAUNCH_FAILED')).toBe(true);
    expect(isAutomaticRetryAllowed('UNRESOLVED_REQUIRED_FIELD')).toBe(false);
    expect(isAutomaticRetryAllowed('OTP_FETCH_FAIL')).toBe(false);
    expect(isAutomaticRetryAllowed(null)).toBe(false);
  });

  it('uses explicit retry metadata instead of inferring safety from error text', () => {
    expect(getRetryReason({ retryReason: 'BROWSER_LAUNCH_FAILED' })).toBe('BROWSER_LAUNCH_FAILED');
    expect(getRetryReason({ errorMessage: 'Target crashed' })).toBeNull();
    expect(getRetryReason(new Error('Target crashed'))).toBeNull();
    expect(getRetryReason('Browser launch failed')).toBeNull();
  });
});
