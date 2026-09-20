-- Rename CAPTCHA_REQUIRED status to OTP_REQUIRED in gh_candidate_applications check constraint.
-- Safe to run on fresh installs where schema.sql already uses OTP_REQUIRED.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name LIKE '%gh_candidate_applications%status%'
      AND table_name = 'gh_candidate_applications'
  ) THEN
    UPDATE gh_candidate_applications
    SET status = 'OTP_REQUIRED'
    WHERE status = 'CAPTCHA_REQUIRED';
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;
