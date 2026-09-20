-- Migration 009: Add EMAIL_PROOF_PENDING status and manual_email_review column
DO $$
BEGIN
  -- 1. Update status CHECK constraint to include 'EMAIL_PROOF_PENDING'
  ALTER TABLE gh_candidate_applications DROP CONSTRAINT IF EXISTS gh_candidate_applications_status_check;
  ALTER TABLE gh_candidate_applications ADD CONSTRAINT gh_candidate_applications_status_check
    CHECK (status IN (
      'READY_FOR_REVIEW',
      'DRY_RUN_COMPLETE',
      'QUEUED',
      'APPLYING',
      'APPLIED',
      'FAILED',
      'EXPIRED',
      'OTP_REQUIRED',
      'CAPTCHA_TIMEOUT',
      'EMAIL_PROOF_PENDING'
    ));

  -- 2. Add manual_email_review column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'gh_candidate_applications' AND column_name = 'manual_email_review'
  ) THEN
    ALTER TABLE gh_candidate_applications ADD COLUMN manual_email_review BOOLEAN DEFAULT false;
  END IF;

  -- 3. Update email_proof_status CHECK constraint to include 'manual_review_needed'
  ALTER TABLE gh_candidate_applications DROP CONSTRAINT IF EXISTS gh_candidate_applications_email_proof_status_check;
  ALTER TABLE gh_candidate_applications ADD CONSTRAINT gh_candidate_applications_email_proof_status_check
    CHECK (email_proof_status IS NULL OR email_proof_status IN ('pending', 'captured', 'timed_out', 'manual_review_needed'));
END $$;
