-- Migration 008: Store confirmation email proof as JSON (no screenshot)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'proof_email_json'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN proof_email_json JSONB;
  END IF;
END $$;
