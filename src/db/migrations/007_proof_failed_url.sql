-- Migration 007: Add proof_failed_url and proof_failed_captured_at to candidate_applications
-- Add RLS policies for proofs_failed and proofs_mail in storage.objects

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'proof_failed_url'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN proof_failed_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'candidate_applications' AND column_name = 'proof_failed_captured_at'
  ) THEN
    ALTER TABLE candidate_applications ADD COLUMN proof_failed_captured_at TIMESTAMPTZ;
  END IF;
END $$;

-- Supabase Storage RLS Policy: proofs_failed bucket (mirrors proofs_dry_run)
DROP POLICY IF EXISTS "Allow storage access to proofs_failed" ON storage.objects;
CREATE POLICY "Allow storage access to proofs_failed" ON storage.objects
    FOR ALL
    USING (bucket_id = 'proofs_failed')
    WITH CHECK (bucket_id = 'proofs_failed');

-- Supabase Storage RLS Policy: proofs_mail bucket (mirrors proofs_dry_run)
DROP POLICY IF EXISTS "Allow storage access to proofs_mail" ON storage.objects;
CREATE POLICY "Allow storage access to proofs_mail" ON storage.objects
    FOR ALL
    USING (bucket_id = 'proofs_mail')
    WITH CHECK (bucket_id = 'proofs_mail');
