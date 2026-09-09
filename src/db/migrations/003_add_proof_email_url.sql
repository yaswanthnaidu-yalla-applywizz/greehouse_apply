-- Migration 003: Add proof_email_url and proof_email_captured_at to candidate_applications
-- Stores the screenshot proof of the confirmation email from Zoho Mail Connector.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'proof_email_url'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN proof_email_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'proof_email_captured_at'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN proof_email_captured_at TIMESTAMPTZ;
  END IF;
END $$;
