-- Migration 022: Keep applications in EMAIL_PROOF_PENDING when automatic email proof polling times out.
-- Existing EMAIL_UNVERIFIED rows retain their web-proof state and are normalized to EMAIL_PROOF_PENDING.

UPDATE gh_candidate_applications
SET
  status = 'EMAIL_PROOF_PENDING',
  email_proof_status = COALESCE(email_proof_status, 'manual_review_needed')
WHERE status = 'EMAIL_UNVERIFIED';

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
    'SKIPPED'
  ));
