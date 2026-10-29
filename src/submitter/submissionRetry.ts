import type { LiveSubmitResult } from './liveSubmit.js';

export type SubmissionRetryReason = 'OTP_FETCH_FAIL' | 'UNRESOLVED_REQUIRED_FIELD' | 'BROWSER_LAUNCH_FAILED';
export type AutomaticSubmissionRetryReason = 'BROWSER_LAUNCH_FAILED';

export function getRetryReason(
  resultOrError: Pick<LiveSubmitResult, 'retryReason' | 'errorMessage'> | Error | string
): SubmissionRetryReason | null {
  if (typeof resultOrError === 'string' || resultOrError instanceof Error) return null;
  return resultOrError.retryReason ?? null;
}

export function isAutomaticRetryAllowed(
  reason: SubmissionRetryReason | null
): reason is AutomaticSubmissionRetryReason {
  return reason === 'BROWSER_LAUNCH_FAILED';
}

/**
 * Determines whether an Ashby submission failure is eligible for automatic retry.
 *
 * Safety rules:
 * - Returns false if submitClicked === true or if stage is SUBMIT_CLICK or WAIT_CONFIRMATION,
 *   to avoid duplicate applications.
 * - Returns false on interactive challenges or permanent data faults.
 * - Returns true only for pre-submit transient stages (e.g. proxy preflight failure or transient navigation error).
 */
export function isAshbySubmissionRetryAllowed(result: LiveSubmitResult): boolean {
  if (result.submitClicked === true) {
    return false;
  }

  const stage = result.telemetry?.stage;
  if (stage === 'SUBMIT_CLICK' || stage === 'WAIT_CONFIRMATION' || stage === 'COMPLETED') {
    return false;
  }

  // Quarantine interactive challenges immediately without auto-retry
  if (result.telemetry?.challengeType && result.telemetry.challengeType !== 'none') {
    return false;
  }

  const errorMsg = result.errorMessage || '';

  // Data faults (missing geography, profile missing, uncommitted required fields) are permanent
  if (
    /data_fault/i.test(errorMsg) ||
    /profile not found/i.test(errorMsg) ||
    /missing_geography/i.test(errorMsg) ||
    /missing_required_field/i.test(errorMsg) ||
    /required field.*uncommitted/i.test(errorMsg)
  ) {
    return false;
  }

  // Only allow retry for transient pre-submit stages: PREFLIGHT, NAVIGATION, DOM_SCAN
  if (stage === 'PREFLIGHT' || stage === 'NAVIGATION' || stage === 'DOM_SCAN') {
    return true;
  }

  return false;
}
