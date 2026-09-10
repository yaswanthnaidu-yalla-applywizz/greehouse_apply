-- Migration 006: Add email_proof_status and email_proof_attempted_at to candidate_applications
-- Fix erroneous FAILED statuses where proof_web_url is present

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'email_proof_status'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN email_proof_status TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'email_proof_attempted_at'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN email_proof_attempted_at TIMESTAMPTZ;
  END IF;
END $$;

-- Fix previously failed records that actually succeeded with web proof
UPDATE candidate_applications
SET status = 'APPLIED', error_message = NULL
WHERE status = 'FAILED' AND proof_web_url IS NOT NULL;

-- Initialize email_proof_status for existing records
UPDATE candidate_applications
SET email_proof_status = 'captured'
WHERE proof_email_url IS NOT NULL AND (email_proof_status IS NULL OR email_proof_status != 'captured');

UPDATE candidate_applications
SET email_proof_status = 'timed_out'
WHERE proof_web_url IS NOT NULL AND proof_email_url IS NULL AND email_proof_status IS NULL;
