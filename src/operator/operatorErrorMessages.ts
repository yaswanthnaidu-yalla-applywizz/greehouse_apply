/**
 * Operator-facing copy for candidate_applications.error_message (and matching API errors).
 * Logs may keep technical detail; persisted dashboard text should use these patterns.
 */

import type { ApplicationStatus } from '../db/applications.js';

export const OperatorErrors = {
  TOO_MANY_QUESTIONS:
    'This job has too many questions. We can only handle up to 35 questions per job.',
  ZOHO_NOT_CONNECTED:
    "Your email isn't connected to our mail system yet. Ask an admin to connect it.",
  PROFILE_NOT_RETRIEVED:
    "We couldn't retrieve your candidate profile. Please contact support.",
  SCAN_FAILED: "We couldn't read this job form. Please try again later.",
  NETWORK: 'Network error. Please try submitting this job again.',
  SUBMISSION_FAILED:
    "We couldn't submit this application. Please try again or contact support.",
  FORM_FILL_FAILED:
    "We couldn't complete this job form. Please review the answers and try again.",
  SUBMIT_BUTTON_MISSING:
    "We couldn't find the submit button on this job form. Please try again later.",
  VERIFICATION_TIMEOUT:
    'This submission took too long to confirm. Please try submitting this job again.',
  OTP_FAILED:
    "We couldn't verify the one-time code for this application. Please try again or contact support.",
  EMAIL_PROOF_PENDING:
    "We're waiting for a confirmation email for this application. Please check back shortly.",
  EXPIRED_JOB: 'This job posting is no longer accepting applications.',
  GENERIC_SUPPORT: 'Please contact support for assistance with this application.',
  RESOLUTION_PENDING:
    "We haven't finished answering this job's questions yet. Please check back shortly.",
} as const;

const FRIENDLY_PREFIX = /^(This job|Your email|We couldn't|We're|Please|Network error|This submission|This application)/i;

function isNetworkError(message: string): boolean {
  return /network error|econnrefused|etimedout|econnreset|enotfound|fetch failed|socket hang up|abort(ed)?|timed out|timeout/i.test(
    message
  );
}

function isPlaywrightScanError(message: string): boolean {
  return /playwright failed to scan|playwright.*scan|failed to scan|scan encountered|browser.*launch/i.test(
    message
  );
}

function isQuestionCapError(message: string): boolean {
  return (
    /\d+\s*fields?\s*\(?>=\s*\d+/i.test(message) ||
    /skipped:.*form fields/i.test(message) ||
    /max_job_questions/i.test(message) ||
    /dashboard cap allows/i.test(message)
  );
}

function isZohoError(message: string): boolean {
  return /not zoho|zoho mail connected|zoho connected|automation is disabled for this profile/i.test(
    message
  );
}

function isProfileError(message: string): boolean {
  return (
    /profile was not written|applywizz profile|profiles row missing|candidate profile.*not found|could not retrieve.*profile|no profiles row/i.test(
      message
    )
  );
}

/**
 * Maps technical/internal failure text to operator-friendly error_message copy.
 */
export function normalizeOperatorErrorMessage(
  raw: string | null | undefined,
  status?: ApplicationStatus | string | null
): string {
  const msg = (raw || '').trim();
  const normalizedStatus = (status || '').toUpperCase();

  if (normalizedStatus === 'SKIPPED') {
    return OperatorErrors.TOO_MANY_QUESTIONS;
  }

  if (!msg) {
    if (normalizedStatus === 'EXPIRED') return OperatorErrors.EXPIRED_JOB;
    if (normalizedStatus === 'EMAIL_PROOF_PENDING') return OperatorErrors.EMAIL_PROOF_PENDING;
    return OperatorErrors.GENERIC_SUPPORT;
  }

  if (FRIENDLY_PREFIX.test(msg)) {
    return msg;
  }

  if (isQuestionCapError(msg)) return OperatorErrors.TOO_MANY_QUESTIONS;
  if (isZohoError(msg)) return OperatorErrors.ZOHO_NOT_CONNECTED;
  if (isProfileError(msg)) return OperatorErrors.PROFILE_NOT_RETRIEVED;
  if (isPlaywrightScanError(msg)) return OperatorErrors.SCAN_FAILED;

  const lower = msg.toLowerCase();

  if (/submit button could not be located/i.test(msg)) {
    return OperatorErrors.SUBMIT_BUTTON_MISSING;
  }
  if (/form filling error|fillsinglefield|failed to populate application fields/i.test(msg)) {
    return OperatorErrors.FORM_FILL_FAILED;
  }
  if (/verification timed out|submission verification timed out|form submission timed out/i.test(msg)) {
    return OperatorErrors.VERIFICATION_TIMEOUT;
  }
  if (isNetworkError(msg)) return OperatorErrors.NETWORK;
  if (/otp solve failed|otp submission verification failed/i.test(msg)) {
    return OperatorErrors.OTP_FAILED;
  }
  if (/confirmation email not found after 10m/i.test(msg)) {
    return OperatorErrors.EMAIL_PROOF_PENDING;
  }
  if (/submission execution failed|submission failed|submit request failed|unexpected submit route|enqueue error/i.test(
    lower
  )) {
    return OperatorErrors.SUBMISSION_FAILED;
  }
  if (/expired|no longer accepting/i.test(lower)) {
    return OperatorErrors.EXPIRED_JOB;
  }

  return OperatorErrors.SUBMISSION_FAILED;
}

export function statusShouldPersistOperatorError(status?: ApplicationStatus | string | null): boolean {
  const s = (status || '').toUpperCase();
  return (
    s === 'SKIPPED' ||
    s === 'FAILED' ||
    s === 'EMAIL_PROOF_PENDING' ||
    s === 'EXPIRED' ||
    s === 'DRY_RUN_COMPLETE'
  );
}
