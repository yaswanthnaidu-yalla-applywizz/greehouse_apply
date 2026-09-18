import type { LiveSubmitResult } from './liveSubmit.js';

export type SubmissionRetryReason = 'OTP_FETCH_FAIL' | 'UNRESOLVED_REQUIRED_FIELD';

export function getRetryReason(
  resultOrError: Pick<LiveSubmitResult, 'retryReason' | 'errorMessage'> | Error | string
): SubmissionRetryReason | null {
  if (typeof resultOrError === 'string') {
    return classifyRetryMessage(resultOrError);
  }
  if (resultOrError instanceof Error) {
    return classifyRetryMessage(resultOrError.message);
  }
  return resultOrError.retryReason || null;
}

function classifyRetryMessage(message: string): SubmissionRetryReason | null {
  if (/OTP_FETCH_FAIL|OTP fetch failed/i.test(message)) return 'OTP_FETCH_FAIL';
  if (/Required field validation failed/i.test(message)) return 'UNRESOLVED_REQUIRED_FIELD';
  return null;
}
