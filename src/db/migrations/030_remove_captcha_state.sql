-- ============================================================================
-- Migration 030: Remove CAPTCHA States
-- Migrates historical CAPTCHA_REQUIRED / CAPTCHA_TIMEOUT rows to FAILED and
-- re-creates the application status CHECK constraint without CAPTCHA states.
-- ============================================================================

UPDATE gh_candidate_applications
SET status = 'FAILED',
    error_message = COALESCE(error_message, 'Application marked FAILED during CAPTCHA state deprecation migration.')
WHERE status IN ('CAPTCHA_REQUIRED', 'CAPTCHA_TIMEOUT');

ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS gh_candidate_applications_status_check;

ALTER TABLE gh_candidate_applications
  DROP CONSTRAINT IF EXISTS candidate_applications_status_check;

ALTER TABLE gh_candidate_applications
  DROP COLUMN IF EXISTS captcha_retry_count;

ALTER TABLE gh_candidate_applications
  ADD CONSTRAINT candidate_applications_status_check
  CHECK (status IN (
    'READY_FOR_REVIEW',
    'APPROVED',
    'DRY_RUN_COMPLETE',
    'QUEUED',
    'APPLYING',
    'APPLIED',
    'FAILED',
    'RETRY',
    'EXPIRED',
    'OTP_REQUIRED',
    'EMAIL_PROOF_PENDING',
    'SKIPPED'
  ));
