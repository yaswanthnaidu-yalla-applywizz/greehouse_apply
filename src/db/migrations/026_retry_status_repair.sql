-- Migration 026: repair deployments where 025 was not applied.
-- Safe to run repeatedly in the Supabase SQL editor.
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
    'RETRY',
    'EXPIRED',
    'OTP_REQUIRED',
    'CAPTCHA_TIMEOUT',
    'CAPTCHA_REQUIRED',
    'EMAIL_PROOF_PENDING',
    'SKIPPED'
  ));
