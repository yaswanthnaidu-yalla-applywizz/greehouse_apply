-- Migration 013: Add EMAIL_UNVERIFIED status to gh_candidate_applications
-- Used when web submission succeeds (with proof screenshot) but confirmation email
-- cannot be verified within the 10-minute polling budget.

ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS gh_candidate_applications_status_check;

ALTER TABLE gh_candidate_applications
  ADD CONSTRAINT gh_candidate_applications_status_check
  CHECK (status IN (
    'READY_FOR_REVIEW',
    'APPROVED',
    'DRY_RUN_COMPLETE',
    'QUEUED',
    'APPLYING',
    'APPLIED',
    'FAILED',
    'EXPIRED',
    'OTP_REQUIRED',
    'CAPTCHA_TIMEOUT',
    'CAPTCHA_REQUIRED',
    'EMAIL_PROOF_PENDING',
    'EMAIL_UNVERIFIED'
  ));
