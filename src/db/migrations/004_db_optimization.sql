-- ============================================================================
-- Migration 004: Database Optimization & Queue Ordering
-- File: src/db/migrations/004_db_optimization.sql
-- ============================================================================

-- 1. Add resume_text and resume_facts to profiles table
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS resume_text TEXT,
  ADD COLUMN IF NOT EXISTS resume_facts JSONB DEFAULT '{}'::jsonb;

-- 2. Migrate data from candidate_resume_parsed if the table exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'candidate_resume_parsed') THEN
    UPDATE profiles p
    SET
      resume_text = r.raw_text,
      resume_facts = r.structured
    FROM candidate_resume_parsed r
    WHERE r.applywizz_id = p.applywizz_id;
  END IF;
END $$;

-- 3. Drop candidate_resume_parsed table
DROP TABLE IF EXISTS candidate_resume_parsed;

-- 4. Drop dead profile columns (Tier 4 deleted, storage bucket removed)
ALTER TABLE profiles
  DROP COLUMN IF EXISTS last_api_fetch_at,
  DROP COLUMN IF EXISTS resume_storage_path;

-- 5. Add queue prioritization columns to candidate_applications
ALTER TABLE candidate_applications
  ADD COLUMN IF NOT EXISTS has_manual_edits BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- 6. Update CHECK constraint on status to include CAPTCHA_TIMEOUT
ALTER TABLE candidate_applications
  DROP CONSTRAINT IF EXISTS candidate_applications_status_check;

ALTER TABLE candidate_applications
  ADD CONSTRAINT candidate_applications_status_check
  CHECK (status IN (
    'READY_FOR_REVIEW',
    'DRY_RUN_COMPLETE',
    'APPLYING',
    'APPLIED',
    'FAILED',
    'EXPIRED',
    'OTP_REQUIRED',
    'CAPTCHA_TIMEOUT'
  ));

-- 7. Drop redundant template_id column from candidate_applications (jobs are identified by job_url)
ALTER TABLE candidate_applications
  DROP COLUMN IF EXISTS template_id;

-- 8. Add queue index for prioritizing unedited applications first
CREATE INDEX IF NOT EXISTS idx_applications_queue_order
  ON candidate_applications(has_manual_edits ASC, reviewed_at ASC)
  WHERE status = 'READY_FOR_REVIEW';
