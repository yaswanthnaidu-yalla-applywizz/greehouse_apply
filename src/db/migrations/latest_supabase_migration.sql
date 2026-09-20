-- ============================================================================
-- Greenhouse V2: Consolidated Migration Script (002 + 003 + 004)
-- Run this script in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/dpwhgwdsfqzfwxlwvchp/sql/new
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Profiles Table: Add resume parsing columns & migrate legacy parsed table
-- ----------------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS resume_text TEXT,
  ADD COLUMN IF NOT EXISTS resume_facts JSONB DEFAULT '{}'::jsonb;

-- Migrate data from candidate_resume_parsed if the table exists
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'candidate_resume_parsed') THEN
    UPDATE profiles p
    SET
      resume_text = r.raw_text,
      resume_facts = r.structured
    FROM candidate_resume_parsed r
    WHERE r.applywizz_id = p.applywizz_id
      AND (p.resume_text IS NULL OR p.resume_text = '');
  END IF;
END $$;

-- Drop obsolete candidate_resume_parsed table and its policies
DROP TABLE IF EXISTS candidate_resume_parsed CASCADE;

-- Drop dead columns from profiles (Tier 4 removed, resume storage path retired)
ALTER TABLE profiles
  DROP COLUMN IF EXISTS last_api_fetch_at,
  DROP COLUMN IF EXISTS resume_storage_path;

-- ----------------------------------------------------------------------------
-- 2. Candidate Applications Table: Add proof & queue prioritization columns
-- ----------------------------------------------------------------------------
ALTER TABLE gh_candidate_applications
  ADD COLUMN IF NOT EXISTS proof_email_url TEXT,
  ADD COLUMN IF NOT EXISTS proof_email_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS has_manual_edits BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Drop redundant template_id column if present (jobs identified by job_url)
ALTER TABLE gh_candidate_applications
  DROP COLUMN IF EXISTS template_id;

-- Migrate any legacy status values before updating constraint
UPDATE gh_candidate_applications
SET status = 'OTP_REQUIRED'
WHERE status = 'CAPTCHA_REQUIRED';

-- Update gh_candidate_applications CHECK constraint for status
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
    'EMAIL_UNVERIFIED',
    'SKIPPED'
  ));

-- ----------------------------------------------------------------------------
-- 3. Indexes: Optimize queue sorting for submit worker
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_applications_template_id;

CREATE INDEX IF NOT EXISTS idx_applications_queue_order
  ON gh_candidate_applications(has_manual_edits ASC, reviewed_at ASC)
  WHERE status = 'READY_FOR_REVIEW';
