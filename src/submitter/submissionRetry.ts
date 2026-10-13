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
